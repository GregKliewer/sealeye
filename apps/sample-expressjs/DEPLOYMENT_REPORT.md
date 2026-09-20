>_ seaLeye.run · DEPLOYMENT_REPORT.md

app: sample-expressjs · profile: poc · region: ca-central-1 · 2026-09-20

---

## What was created

- A public HTTPS address for your app. There is no server for you to run, patch or scale.
- Your app running unchanged on Node.js 20 (function `sample-expressjs`). The platform starts it with `node index.js` and hands it real HTTP requests.
- Somewhere to read what your app printed (log group `/aws/lambda/sample-expressjs`, kept for 30 days).

All of it is one CloudFormation stack, `sealeye-sample-expressjs`, in ca-central-1. Deleting that stack deletes everything above and nothing else.

## Your URL

https://fiy6vwvpld.execute-api.ca-central-1.amazonaws.com

## Logs

Everything your app prints goes here. Follow it live with:

```
aws logs tail /aws/lambda/sample-expressjs --follow
```

## Redeploy

Change your code, then run `sealeye deploy` again in this folder. The URL stays the same — it belongs to the environment, not to any one deployment.

## Tear down

When you are finished with this environment:

```
sealeye destroy dep_93cf294e5607
```

That deletes the stack and everything in it.

## Assumptions carried from the plan

These came from your answers, not from anything seaLeye.run guessed for you:

- Profile: `poc`
- What you asked for:
  - `http_api_serverless` — runtime: nodejs, entry_point: index.js, trigger: http
  - `observability_basic` — target: auto, retention_days: 30
- Outputs you asked for: public_url, logs
- Region: ca-central-1 — fixed for this environment.
- Deployed from `/Users/gregkliewer/dev/deployme-demo/apps/sample-expressjs` (artifact `sample-expressjs/dep_93cf294e5607.zip`).
- Your app was not modified. The start script the platform needs was added to the uploaded copy, not to your source. This report is the only file seaLeye.run writes into your folder.
