# sealeye init scoring (POC1 criteria A to F, 1 to 5)

| Criterion | api-1 | api-2 | static-1 | Notes |
|---|---|---|---|---|
| A. Question quality | |4 |4 | |
| B. Relevance | |4 |4 | |
| C. Developer experience | |2 |2 |It is easy to conclude that sealeye is frozen when reading the app as there is no visual feedback while that runs. I would like to see a simple version of the deployment plan markdown before saying yes on top of the simple prose readout. |
| D. Cognitive load | |5 |5 |1 is high, 5 is low | 
| E. Recommendation clarity | |3 |3 | The single-paragraph, prose readout is a lot of text; we could try bullet-form instead.|
| F. Adaptation across apps | |4 |4 | (one score for the set) |

## Questions asked, verbatim
### api-1: 

? Quick check: this looks like a small live web API that answers requests when someone visits it (not a script that runs once and exits). Is that right? y

Your app is a small Express server (index.js) that listens for requests and responds, confirmed as a live web API rather than a one-off script. It will run behind an on-demand HTTPS endpoint that starts when a request comes in and costs nothing while idle, using the http_api_serverless module, with your existing start command (node index.js) as the entry point. The observability_basic module is included so you automatically get logs plus request, error and latency tracking without any setup. Your app only reads the PORT setting, which the platform supplies itself, so no environment variable configuration was needed and that module is left off. No custom domain is attached, but a public HTTPS URL will be generated for you once it deploys.

  Wrote /private/tmp/try-api/DEPLOYMENT_PLAN.md
  Wrote /private/tmp/try-api/deployme.yaml

? Deploy this? [y/N] n

### api-2: 

? Just to confirm: this app starts up and stays running, answering requests over HTTP, rather than running once and exiting. Is that right? y

Your app is a small Express server (index.js) that listens for HTTP requests and responds with a sample page. It will run behind an HTTPS endpoint that starts up when a request comes in and costs nothing while idle, using the http_api_serverless module. Alongside it, observability_basic will collect your logs and track requests, errors and response times automatically, no setup needed. Since your code only reads the PORT the platform assigns and nothing else from the environment, config_basic is included in the plan but turned off. domain_public is also included but turned off, since this version generates a public HTTPS URL for you rather than attaching a domain you own. Once deployed you will get back a public URL, your logs and your metrics.

  Wrote /private/tmp/try-api/DEPLOYMENT_PLAN.md
  Wrote /private/tmp/try-api/deployme.yaml

? Deploy this? [y/N] y

### static-1:

This is clearly a static site: index.html, about.html, style.css, an images folder, and no server code or dependencies anywhere. I see index.html and about.html, with images and style.css and no server code. This looks like a static site. Is that right? y

Your app is a static website: a home page, an about page, some CSS and a background image, with no server code behind it. It will run on the static_site_edge module, which just serves those files straight to visitors over HTTPS. The observability_basic module is included for every app and will quietly track requests, errors and response times, and keep logs, without any setup on your part. The http_api_serverless module is off since nothing here listens for requests, config_basic is off since the app does not read any settings from its environment, and a custom domain (domain_public) is off for now, though one can be added later. Once deployed you'll get a public HTTPS link to the site plus access to its logs and basic metrics. Deploy this? [y/N] y


## Modules chosen

### api-1:

The correct ones.

### api-2:

The correct ones.

### static-1:

The correct ones.

## Prompt changes made

None.