app.get("/", function(req, res) {
  var https = require("https");
  var url = "https://raw.githubusercontent.com/alimo1989/solid-journey/main/index.html";
  https.get(url, function(r) {
    var data = "";
    r.on("data", function(chunk) { data += chunk; });
    r.on("end", function() {
      res.setHeader("Content-Type", "text/html");
      res.send(data);
    });
  }).on("error", function(e) {
    res.status(500).send("Error: " + e.message);
  });
});
