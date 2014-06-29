module.exports = function () {
    var dnsd   = require('dnsd'),
        dns    = require('native-dns');

    function Dns(config) {
        var $this    = this;
        this.config  = {};
        this.config.host       = process.env.DNSINTERFACE             || config.dns.host;
        this.config.port       = process.env.DNSPORT                  || config.dns.port;
        this.config.zone       = process.env.DNSZONE                  || config.dns.zone;
        this.config.ttl        = process.env.DNSTTL                   || config.dns.ttl;
        this.config.prefix     = process.env.DNSPREFIX                || config.dns.prefix;
        this.config.primary    = process.env.DNSPRIMARY               || config.dns.primary;
        this.config.secondary  = process.env.DNSSECONDARY             || config.dns.secondary;
        this.config.timeout    = process.env.DNSTIMEOUT               || config.dns.timeout;
        this.redis             = config.redis;
        this.meta              = config.meta;
        this.logger            = config.logger;
        this.logger.log('debug', "dns-config=%j", this.config, this.meta);
        this.logger.log('debug', "env=%j", process.env, this.meta);
    }

    Dns.prototype.nativeDNS = function (dnsAddress, question, hostname, req, res, next) {
        var timedout = false;
        var $this = this,
            nativeQuestion = dns.Question({
                                name : question.name,
                                type : 'A'
                             }),
            nativeReq = dns.Request({
                            question : nativeQuestion,
                            server   : { 
                                address : dnsAddress, 
                                port    : 53, 
                                type    : 'udp'
                            },
                            timeout: $this.config.timeout
                        });

        nativeReq.on('timeout', function () {
            if (dnsAddress === $this.config.secondary) {
                $this.logger.log('error', '%s:%s/%s - %s - %s question:"%s" - %j -- timeout', req.connection.remoteAddress, req.connection.remotePort, req.connection.type, dnsAddress, hostname, question, res.answer, $this.meta);
                return next(new Error('DNS:nativeDNS:timeout: ' + $this.config.secondary));
            }
            $this.logger.log('warn', '%s:%s/%s - %s - %s question:"%s" - %j -- timeout', req.connection.remoteAddress, req.connection.remotePort, req.connection.type, dnsAddress, hostname, question, res.answer, $this.meta);
            timedout = true;
            $this.nativeDNS($this.config.secondary, question, hostname, req, res, next);
        });

        nativeReq.on('message', function (err, answer) {
            answer.answer.forEach(function (oneAnswer) {
                answer = {
                    name : hostname,
                    type : 'A',
                    data : oneAnswer.address,
                    ttl  : $this.config.ttl
                };
                res.answer.push(answer);
            });
        });

        nativeReq.on('end', function () {
            if (!timedout) {
                $this.logger.log('info', '%s:%s/%s - %s - %s question:"%s" - %j', req.connection.remoteAddress, req.connection.remotePort, req.connection.type, dnsAddress, hostname, question, res.answer, $this.meta);
                next(null);
            }
        });

        nativeReq.send();
    };

    Dns.prototype.resolver = function(req, res) {
        var $this        = this,
            question     = res.question[0], 
            hostname     = question.name, 
            length       = hostname.length, 
            answer       = {};

        if(question.type !== 'A') {
            return res.end();
        }
        this.redis.get(this.config.prefix + hostname, function (err, value) {
            if (err) {
                $this.logger.log('error', 'dns/local GET hostname "%s" - err=%j', hostname, err, $this.meta);
                return res.end();
            }
            // Got something from REDIS?
            if(value !== null && value.length > 0) {
                answer = {
                    name : hostname, 
                    type : 'A', 
                    data : value, 
                    ttl  : $this.config.ttl
                };
                res.answer.push(answer);
                $this.logger.log('info', '%s:%s/%s - local - %s question:"%s" - %j', req.connection.remoteAddress, req.connection.remotePort, req.connection.type, hostname, question, answer, $this.meta);
                res.end();
            } else {
                // Send the requestion to another DNS server
                $this.nativeDNS($this.config.primary, question, hostname, req, res, function (err) {
                    if (err) {
                        $this.logger.log('error', '%s:%s/%s - local - %s question:"%s" - %j -- ERROR:%j', req.connection.remoteAddress, req.connection.remotePort, req.connection.type, hostname, question, res.answer, err, $this.meta);
                    }
                    res.end();
                });
            }
        });
    };

    Dns.prototype.start = function() {
        var $this = this;
        this.server = dnsd.createServer(function (req, res) {
            $this.resolver(req, res);
        });

        this.server.zone($this.config.zone, 
                         'ns1.'+$this.config.zone, 
                         'us@'+$this.config.zone, 
                         'now', '2h', '30m', '2w', '10m'
                        ).listen($this.config.port, $this.config.host);
    };

    function create(pkgConfig) {
        return new Dns(pkgConfig);
    }

    return {
        create : create
    };
}();