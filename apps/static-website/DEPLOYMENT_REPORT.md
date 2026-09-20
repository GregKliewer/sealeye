>_ seaLeye.run · DEPLOYMENT_REPORT.md

app: static-website · profile: poc · region: ca-central-1 · 2026-09-20

---

## What was created

- A public website, served straight from storage. Anyone with the link can open it.
- The storage holding your files (bucket `static-website-682542496821`).

All of it is one CloudFormation stack, `sealeye-static-website`, in ca-central-1. Deleting that stack deletes everything above and nothing else.

## Your URL

http://static-website-682542496821.s3-website.ca-central-1.amazonaws.com

That address is `http://`, not `https://`. This profile serves your files straight out of storage with no CDN in front of them, and a storage-hosted site is plain HTTP. The CDN is what adds `https://` and your own domain name — it is a deliberate omission here, not something that went wrong.

## Logs

A static site has no application logs — nothing of yours is running. Requests are served directly from storage.

## Redeploy

Change your files, then run `sealeye deploy` again in this folder. The URL stays the same — it belongs to the environment, not to any one deployment.

## Tear down

When you are finished with this environment:

```
sealeye destroy dep_71d40acbe6cc
```

That deletes the stack and everything in it.

## Assumptions carried from the plan

These came from your answers, not from anything seaLeye.run guessed for you:

- Profile: `poc`
- What you asked for:
  - `static_site_edge` — site_root: ., entry_point: index.html
  - `observability_basic` — target: auto, retention_days: 30
- Outputs you asked for: public_url, logs
- Region: ca-central-1 — fixed for this environment.
- Deployed from `/Users/gregkliewer/dev/deployme-demo/apps/static-website`.
- Your files were not modified. seaLeye.run uploaded a copy of them. This report is the only file it writes into your folder.
