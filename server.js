// server.js
// where your node app starts

// init project
const express = require('express');
const fs = require('fs');
const hbs = require('hbs');
const os = require('os');
const rp = require('request-promise-native');
const request = require('request');
const bodyParser = require('body-parser');
const async = require('async');
const minio = require('minio');
const multer  = require('multer');
const Readable = require('stream').Readable;
const { URL } = require('url');
const geturls = require('get-urls');
const yaml = require('js-yaml');
const psl = require('psl');
const cheerio = require('cheerio');

// hack for nodejs SSL error: https://github.com/nodejs/node/issues/16196
require("tls").DEFAULT_ECDH_CURVE = "auto";

const app = express();

app.use(bodyParser.urlencoded({ extended: false }));
//app.use(express.static('static'));
app.set('view engine', 'hbs');
app.set('views', './templates');
//app.use(express.static('public'));

hbs.registerPartial("above", fs.readFileSync("./partials/above.hbs", "utf-8"));
hbs.registerPartial("below", fs.readFileSync("./partials/below.hbs", "utf-8"));

hbs.registerHelper('isUrl', function(url, options) { return this.url == url || this.url.startsWith(url + "?") ? options.fn(this) : '';});
hbs.registerHelper('isParam', function(param, value, options) { return options.data.root[param] == value ? options.fn(this) : options.inverse(this);});
hbs.registerHelper('toJSON', function(object){ return JSON.stringify(object);});  //NOTE: use new hbs.SafeString() if you need to avoid HTML encoding
hbs.registerHelper('hasAlternate', function(site, options) { return ('alt' + site) in options.data.root.metadata  && options.data.root.metadata['alt' + site].length > 1; });
hbs.registerHelper('getAlternates', function(site, options) { return options.data.root.metadata['alt' + site]; });

const USER_AGENT = "vlz-meta-maker";

const minioClient = new minio.Client({
  endPoint: 's3.amazonaws.com',
  secure: true,
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY
});

function getStatus() {
	const retVal = {};

	retVal["success"] = true;
	retVal["message"] = "OK";
    retVal["timestamp"] = new Date().toISOString();
    retVal["lastmod"] = process.env.LASTMOD || null;
    retVal["commit"] = process.env.COMMIT || null;
	retVal["__dirname"] = __dirname;
	retVal["__filename"] = __filename;
	retVal["os.hostname"] = os.hostname();
	retVal["os.type"] = os.type();
	retVal["os.platform"] = os.platform();
	retVal["os.arch"] = os.arch();
	retVal["os.release"] = os.release();
	retVal["os.uptime"] = os.uptime();
	retVal["os.loadavg"] = os.loadavg();
	retVal["os.totalmem"] = os.totalmem();
	retVal["os.freemem"] = os.freemem();
	retVal["os.cpus.length"] = os.cpus().length;
	// too much junk: retVal["os.networkInterfaces"] = os.networkInterfaces();
	
	retVal["process.arch"] = process.arch;
	retVal["process.cwd"] = process.cwd();
	retVal["process.execPath"] = process.execPath;
	retVal["process.memoryUsage"] = process.memoryUsage();
	retVal["process.platform"] = process.platform;
	retVal["process.release"] = process.release;
    retVal["process.title"] = process.title;
	retVal["process.uptime"] = process.uptime;
	retVal["process.version"] = process.version;
	retVal["process.versions"] = process.versions;
	retVal["process.installPrefix"] = process.installPrefix;
	
	return retVal;
}

function isBlog(url) {
    if (url.host.startsWith("blog.") || url.pathname.endsWith("/blog") || url.pathname.endsWith("/blog/")) {
        return true;
    }
    return false;
}

function isFacebook(url) {
    if (url.host.endsWith("facebook.com")) {
        if (url.pathname == '/'
            || url.pathname == '/tr'
            || url.pathname.endsWith("/fbml")
            || url.pathname.startsWith("/sharer")
        ) {
            return false;
        }
        return true;
    }
    return  false;
}

function isGithub(url) {
    if (url.host.endsWith("github.com") == false) {
        return false;
    }

    if (url.pathname.match("^/[-A-Za-z0-9]+(/[-A-Za-z0-9]+)?$")) {
        return true;
    }
    return  false;
}

function isLinkedIn(url) {
    if (url.hostname != "linkedin.com" && url.hostname != "www.linkedin.com") {
        return false;
    }
    if (url.pathname == '/'  || url.pathname == '/shareArticle') {
        return false;
    }
    return true;
}

function isTwitter(url) {
    if (!url.host.endsWith("twitter.com")) {
        return false;
    }
    if (url.host == "platform.twitter.com") {
        return false;
    }
    if (url.pathname == '/' || url.pathname.startsWith("/intent/")) {
        return false;
    }
    return true;
}

function onlyPathname(url) {
    return url.pathname.substring(1);
}

const socialSites = [
    { id: "blog", fn: isBlog },
    { id: "dribbble", fn: function(url) { return url.hostname == "dribbble.com" } },
    { id: "facebook", fn: isFacebook },
    { id: "flickr", fn: function(url) { return url.hostname == "www.flickr.com" } },
    { id: "github", fn: isGithub, cleanup: onlyPathname },
    { id: "googleplus", fn: function(url) { return url.hostname == "plus.google.com" } },
    { id: "instagram", fn: function(url) { return url.hostname == "instagram.com" || url.hostname == "www.instagram.com" } },
    { id: "linkedin", fn: isLinkedIn },
    { id: "pinterest", fn: function(url) { return url.hostname == "pinterest.com" ||  url.hostname == "www.pinterest.com" } },
    { id: "reddit", fn: function(url) { return url.hostname == "www.reddit.com" } },
    { id: "tumblr", fn: function(url) { return url.hostname == "www.tumblr.com" } },
    { id: "twitter", fn: isTwitter, cleanup: onlyPathname },
    { id: "wikipedia", fn: function(url) { return url.hostname == "en.wikipedia.org" } },
    { id: "youtube", fn: function(url) { return (url.hostname == "youtube.com" || url.hostname == "www.youtube.com") && url.pathname != '/' } },
];


app.get('/status.json', function(req, res) {
    res.writeHead(200, {
        "Content-Type": "text/plain",
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET',
        'Access-Control-Max-Age': '604800',
    });

    sendJson(req, res, getStatus());
});

const asyncMiddleware = fn =>
    (req, res, next) => {
        Promise.resolve(fn(req, res, next))
            .catch(next);
    };

app.get('/robots.txt', function(req, res) {

    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.write("User-Agent: *\n");
    res.write("Disallow: /\n");
    res.end();

});

app.get('/favicon.ico', function(req, res) {
    request.get(process.env.FAVICON_ICO).pipe(res);
});

app.get('/favicon.svg', function(req, res) {
    request.get(process.env.FAVICON_SVG).pipe(res);
});

app.get('/', function(req, res) {
    res.render("index", { step: "url", recaptcha: process.env.RECAPTCHA_SITEKEY });
    return;
});

app.post('/', multer({ storage: multer.memoryStorage() }).single('file'), asyncMiddleware(async (req, res, next) => {

    if (req.body["step"] == "confirm") {
        var logodata = Object.assign({ "created": new Date().toISOString() }, req.body);
        delete logodata.step;
        socialSites.forEach(function(ss) {
            if (logodata[ss.id] == "") {
                delete logodata[ss.id];
            }
        });
        if (logodata.guide == "") {
            delete logodata.guide;
        }
        if (logodata.notes == "") {
            delete logodata.notes;
        }
        console.log("logodata=" + JSON.stringify(logodata));
        var s = new Readable;
        s.push(yaml.safeDump(logodata, { lineWidth: 4096, noRefs: true, sortKeys: true }));
        s.push(null);
        try {
            await minioClient.putObject(process.env.S3_BUCKET, logodata.logohandle + ".yaml", s);
            res.render("index", { step: "url", recaptcha: process.env.RECAPTCHA_SITEKEY, url: "", msgtype: "success", msgtext: "Metadata for '" + logodata.logohandle + "' saved!" });
        } catch (err) {
            console.error(err);
            res.write("FAILED: " + err.message);
            res.end();
        }

        return;
    }

    const url = req.body["url"];
    if (url == null || url.length === 0) {
        res.render("index", { step: "url", recaptcha: process.env.RECAPTCHA_SITEKEY, msgtype: "danger", msgtext: "URL is required" });
        return;
    }

    var recaptchaSecret = process.env.RECAPTCHA_SECRET;
    if (recaptchaSecret) {
        const recaptchaStr = await rp({
            url: "https://www.google.com/recaptcha/api/siteverify",
            method: "POST",
            form: {secret: recaptchaSecret, response: req.body["g-recaptcha-response"]},
            timeout: 10000,
        });

        const recaptcha = JSON.parse(recaptchaStr);


        if (!recaptcha.success) {
            console.log("INFO: body=" + JSON.stringify(req.body));
            console.log("INFO: recaptcha=" + JSON.stringify(recaptcha));
            res.render("index", {
                step: "url",
                recaptcha: process.env.RECAPTCHA_SITEKEY,
                url: url,
                msgtype: "danger",
                msgtext: "Sorry, reCaptcha things you are a bot.  Maybe try again?"
            });
            return;
        }

        if (recaptcha.hostname != "localhost" && recaptcha.hostname != process.env.RECAPTCHA_HOSTNAME) {
            console.log("INFO: body=" + JSON.stringify(req.body));
            console.log("INFO: recaptcha=" + JSON.stringify(recaptcha));
            res.render("index", {
                step: "url",
                recaptcha: process.env.RECAPTCHA_SITEKEY,
                url: url,
                msgtype: "danger",
                msgtext: "That's funny: reCaptcha thinks you are solving on '" + recaptcha.hostname + "'. Why is that?"
            });
            return;
        }
    }

    const mainURL = new URL(url);

    const options = {
        url: url,
        //encoding: null,
        headers: {
            'User-Agent': USER_AGENT
        },
        resolveWithFullResponse: true,
        timeout: 10000  // in millis
    };
    const response = await rp(options);
    const buf = response.body;

    const messages = [];

    const metadata = { "website": response.request.uri.href };
    if (url != response.request.uri.href) {
        metadata.originalurl = url;
    }

    const match = buf.match(new RegExp("<title>(.*)</title>"));
    if (match != null) {
        metadata.title = match[1];
    } else {
        messages.push("WARNING: no title");
    }

    const urls = geturls(buf);

    urls.forEach(function(strURL) {
        //res.write("url=" + strURL + "\n");
        try {
            if (strURL.endsWith("%27")) {
                strURL = strURL.slice(0, -3);
            }
            const theURL = new URL(strURL);

            socialSites.forEach(function (theSite) {
                if (theSite.fn(theURL)) {
                    const siteURL = theSite.cleanup ? theSite.cleanup(theURL) : theURL.href;
                    if (metadata[theSite.id]) {
                        metadata['alt' + theSite.id].push(siteURL);
                    }
                    else {
                        metadata[theSite.id] = siteURL;
                        metadata['alt' + theSite.id] = [ siteURL ];
                    }
                }
            });
        }
        catch (err) {
            messages.push("ERROR: " + err);
        }
    });

    const parsed = psl.parse(mainURL.host);
    metadata.sort = parsed.sld;
    if (parsed.tld == "com" || parsed.tld == "org") {
        metadata.logohandle = parsed.sld
    }
    else {
        metadata.logohandle = parsed.domain.replace('.', '');
    }

    if (req.body["step"] == "url") {
        res.render("confirm", { metadata: metadata, socialsites: socialSites, step: "confirm" });
    }
}));

app.use(function (req, res, next) {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.status(404).send("404: unable to find file '" + req.url + "'");
});

app.use(function (err, req, res, next) {
    console.error(err.stack);
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.status(500).send("500: " + err);
});

function sendJson(req, res, jsonObj) {
    if ('callback' in req.query)
    {
        res.write(req.query["callback"]);
        res.write("(");
        res.write(JSON.stringify(jsonObj));
        res.write(");");
    }
    else
    {
        res.write(JSON.stringify(jsonObj));
    }
    res.end();
}

const listener = app.listen(process.env.PORT || 4000, function () {
    console.log('Listening on port ' + listener.address().port);
});

