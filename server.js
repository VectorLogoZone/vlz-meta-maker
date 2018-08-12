// server.js
// where your node app starts

// init project
const express = require('express');
var fs = require('fs');
var hbs = require('hbs');
var os = require('os');
var rp = require('request-promise-native');
var request = require('request');
var bodyParser = require('body-parser');
var async = require('async');
var minio = require('minio');
var multer  = require('multer');
const Readable = require('stream').Readable;
const { URL } = require('url');
var geturls = require('get-urls');
var yaml = require('js-yaml');
var psl = require('psl');
const cheerio = require('cheerio')

var app = express();

app.use(bodyParser.urlencoded({ extended: false }));
app.set('view engine', 'hbs');
app.set('views', './templates');
//app.use(express.static('public'));

hbs.registerPartial("above", fs.readFileSync("./partials/above.hbs", "utf-8"));
hbs.registerPartial("below", fs.readFileSync("./partials/below.hbs", "utf-8"));

hbs.registerHelper('isUrl', function(url, options) { return this.url == url || this.url.startsWith(url + "?") ? options.fn(this) : '';});
hbs.registerHelper('isParam', function(param, value, options) { return options.data.root[param] == value ? options.fn(this) : options.inverse(this);});
hbs.registerHelper('toJSON', function(object){ return JSON.stringify(object);});  //NOTE: use new hbs.SafeString() if you need to avoid HTML encoding

const USER_AGENT = "vlz-meta-maker";

const minioClient = new minio.Client({
  endPoint: 's3.amazonaws.com',
  secure: true,
  accessKey: process.env.S3_ACCESS_KEY,
  secretKey: process.env.S3_SECRET_KEY
});

function getStatus() {
	var retVal = {}

	retVal["success"] = true;
	retVal["message"] = "OK";
	retVal["timestamp"] = new Date().toISOString();
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

// true if there is a favicon at this url
async function checkFavicon(res, url) {
  var options = {
    url: url,
    encoding: null,
    headers: {
      'User-Agent': USER_AGENT
    },
    resolveWithFullResponse: true,
    timeout: 1500
  };
  
  var response;
  try {
    response = await rp(options);
    
  }
  catch (err) {
    var errmsg = (err.name == "StatusCodeError" && err.statusCode == 404) ? "404" : JSON.stringify(err);
    res.write("WARNING: unable to load favicon from '" + url + "' (err=" + errmsg + ")");
    return false;
  }
  var buf = response.body;
  var mimetype = response.headers['content-type'];
  if (!buf || buf.length == 0) {
    return false;
  }
  if (mimetype.startsWith("image/") == false) {
    res.write("WARNING: favicon exists but not an image (mimetype=" + mimetype + ")");
    return false;
  }
  return true;
}

function findFaviconURL(res, base, html) {
  const $ = cheerio.load(html);
  
  var links = $('link[rel="shortcut icon"]');
  if (links.length == 0) {
    links = $('link[rel="icon"]');
  }
  
  if (links.length == 0) {
    return null;
  }
  
  //var link = cheerio.load(links[0]);
  //console.log(links[0]);
  //return null;
  
  return new URL(links.attr("href"), base).href;
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
  console.log("LI=" + JSON.stringify(url.pathname));
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

var socialSites = [
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
  return;
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
  res.render("index", { "step": "url" });
  return;
});

app.post('/', multer({ storage: multer.memoryStorage() }).single('file'), asyncMiddleware(async (req, res, next) => {
  
    var buf = null;
    var mimetype = null;
  
    //res.setHeader("content-type", "text/plain; charset=utf-8");
    if (req.body["step"] == "confirm") {
      var logodata = Object.assign({ "created": new Date().toISOString() }, req.body);
      delete logodata.step;
      socialSites.forEach(function(ss) {
        if (logodata[ss.id] == "") {
          delete logodata[ss.id];
        }
      });
      console.log("logodata=" + JSON.stringify(logodata));
      var s = new Readable;
      s.push(yaml.safeDump(logodata, { lineWidth: 4096, noRefs: true, sortKeys: true }));
      s.push(null);
      try {
          await minioClient.putObject(process.env.S3_BUCKET, logodata.logohandle + ".yaml", s);
          res.write("SUCCESS!");
      } catch (err) {
          console.error(err);
          res.write("FAILED: " + err.message);
      }
      res.end();
      return;
    }
  
    var url = req.body["url"];
    if (url == null) {
      res.write("ERROR: url is required");
      res.end();
      return;
    }
  
    var mainURL = new URL(url);
  
    var options = {
      url: url,
      //encoding: null,
      headers: {
        'User-Agent': USER_AGENT
      },
      resolveWithFullResponse: true,
      timeout: 10000  // in millis
    };
    var response = await rp(options);
    buf = response.body;
    mimetype = response.headers['content-type'];
  
    var messages = [];
  
  //res.write("Content-Type     : " + mimetype + "\n");
  //res.write("Buffer size      : " + buf.length + "\n");
  //console.log("buf=" + buf.substring(0, 500) + "\n");
  const text = 'Lorem ipsum dolor sit amet, //sindresorhus.com consectetuer adipiscing http://yeoman.io elit.';
  
  var metadata = { "website": url};
  
  var match = buf.match(new RegExp("<title>(.*)</title>"));
  if (match != null) {
    metadata.title = match[1];
  } else {
    messages.push("WARNING: no title");
  }

  var urls = geturls(buf);
  
  urls.forEach(function(strURL) {
    //res.write("url=" + strURL + "\n");
    try {
      if (strURL.endsWith("%27")) {
        strURL = strURL.slice(0, -3);
      }
      const theURL = new URL(strURL);
      
      socialSites.forEach(function (theSite) {
        if (theSite.fn(theURL)) {
          if (metadata[theSite.id]) {
            messages.push("WARNING: multiple " + theSite.id + " URLs! (" + theURL.href + ")");
          }
          else {
            if (theSite.cleanup) {
              metadata[theSite.id] = theSite.cleanup(theURL);
            } else {
              metadata[theSite.id] = theURL.href;
            }
          }
        }          
      });
    }
    catch (err) {
      messages.push("ERROR: " + err);
    }
  });
  
  
  if (false) { //NO: now stored in a separate file & updated with python script
    /*
     * see if there is a favicon in the subdirectory
     */
    if (mainURL.pathname != "/") {
      var faviconPathname = mainURL.pathname;
      while (faviconPathname.length > 0 && faviconPathname.endsWith('/') == false) {
        faviconPathname = faviconPathname.slice(0, -1);
      }
      var faviconURL = mainURL.origin + faviconPathname + "favicon.ico";
      if (await checkFavicon(res, faviconURL)) {
        metadata.favicon = faviconURL;
      }
    }

    /*
     * see if there is a root favicon
     */
    if (!metadata.favicon) {
      var faviconURL = mainURL.origin + "/favicon.ico";
      if (await checkFavicon(res, faviconURL)) {
        // default, no need to save
        res.write("INFO: default favicon found at '" + faviconURL + "'\n");
      }
      else {
        var customFaviconURL = findFaviconURL(res, url, buf);
        if (customFaviconURL != null) {
          metadata.favicon = customFaviconURL;
        }
      }
    }
  }  
  
  
  var parsed = psl.parse(mainURL.host);
  metadata.sort = parsed.sld;
  if (parsed.tld == "com" || parsed.tld == "org") {
    metadata.logohandle = parsed.sld
  }
  else {
    metadata.logohandle = parsed.domain.replace('.', '');
  }
  
  if (req.body["step"] == "url") {
      res.render("confirm", { metadata: metadata, socialsites: socialSites, step: "confirm" });
  } else if (req.body["step"] == "sconfirm") {
    var f = fs.createWriteStream(metadata.logohandle + ".txt");
    f.write("---\n");
    f.write(yaml.safeDump(metadata, {sortKeys: true } ));
    f.write("---\n");
    f.end();
  }

  /*
  res.write("\n\necho \"---\n");
  res.write(yaml.safeDump(metadata, {sortKeys: true } ));
  res.write("---\n");
  res.write("\" >" + metadata.logohandle + ".txt\n\n");
  //res.write("Complete!\n");
  res.end();
  */
   
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

var listener = app.listen(process.env.PORT || 4000, function () {
    console.log('Listening on port ' + listener.address().port);
});

