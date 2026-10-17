# Modules for checking root modules with real OpenTofu

Two small Terraform modules in the shapes seaLeye builds today (PHASE4-PLAN Step 9): one
that runs an app as a function behind an HTTPS address (it takes a zipped app and the
function to call), and one that serves a site's files through a content network (it
says where to upload them). Written for seaLeye's own checks, after the made-up
organization's `http-api` and `static-site`, which are in a private repository.

`scripts/tofu-check.js` writes the root module seaLeye would write for each, and runs
`tofu init`, `validate` and `plan` on it, building nothing. GitHub Actions runs it
(`.github/workflows/tofu.yml`), since OpenTofu cannot be fetched where seaLeye is
mostly built.
