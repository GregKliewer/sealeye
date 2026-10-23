# Welcome to seaLeye

Thanks for trying seaLeye. This note takes about twenty minutes to work through, on
your own machine, with nobody's help. That is the point of the test: if a step is
unclear, that is worth knowing, so say so rather than working around it.

## What seaLeye is

seaLeye puts your app online in a development environment without you writing any
infrastructure. You run one command in your app's folder. It reads the app, asks you up
to four questions, and shows you a plan in plain language. If you say yes, it builds the
environment from parts your platform team already trusts, and gives you an address. If
your app needs something the platform cannot build yet, it says so, shows you what in
your code shows the need, and builds nothing.

There are two ways in, and they show the same things: the `sealeye` command, and the
website at https://sealeye.online.

## What you need

- A Mac or Linux machine, with Node.js 20 or later (`node -v` shows yours; get it from
  https://nodejs.org if you need to), and a terminal: `sealeye run` asks you questions,
  so it runs in one, not in a script.
- The token Greg sent you, separately from this note. It starts with `sl_`. Treat it
  like a password: it is yours alone, and it is never typed on a command line.
- The sample apps Greg sent you as a zip. Unzip it somewhere you like.

## 1. Install the command

```bash
curl -fsSL https://sealeye.run/install | sh
```

It downloads the command into a folder of its own in your home folder, puts `sealeye`
on your PATH, and ends with "Done." It needs curl and tar, which Macs and most Linux
machines have. If it stops saying your global npm folder needs administrator rights, do
what its message says, then run it again. Check with `sealeye --help`.

## 2. Sign in

```bash
sealeye login
```

Paste your token when it asks. It is not shown as you paste. You should see
"Signed in as" with your name and your team. `sealeye whoami` shows the same at any
time, and `sealeye doctor` checks everything this machine needs.

## 3. Your first environment

Go into one of the sample apps and run seaLeye there:

```bash
cd beneficiary-lookup-api
sealeye run
```

- It reads the folder first, then asks its questions one at a time. Answer them as you
  would for your own app.
- It shows a plan: what it will build, and why. Read it.
- It asks "Deploy this? [y/N]". Type `y` to go ahead. Anything else stops, and nothing
  is built.
- If you run it again in a folder whose app is already live, it says so first and asks
  "Continue? [y/N]": going on updates that environment, it does not make a second one.
- Building takes a few minutes and carries on in the background: it prints a
  deployment id (it starts with `dep_`) and gives you your terminal back, with a notice
  when it is done if your machine can show one. `sealeye watch`, in the same folder,
  follows it to the end (`sealeye run --watch` stays from the start), and `sealeye
  list` shows the address once it is ready. Open the address in a
  browser: it is your app, running.

You can keep the app's name as it is. Other people may have an app with the same name;
yours is still your own environment.

Then try `static-website` the same way. It is a plain website rather than an API, so
the questions and the plan are different.

## 4. A refusal, on purpose

Run seaLeye in `payment-events-processor`. That app needs things the platform cannot
build yet, so seaLeye builds nothing. It saves the plan as a draft and lists each need
with what in the code shows it. That is the expected result, not an error.

## 5. The website

Open https://sealeye.online (or run `sealeye online`, or `sealeye online <app>` to go
straight to that app's page) and sign in with the same token. You should see the
environments you just made, with their state and addresses. Click one to see its
history.

Tear one of them down from the website: open it and choose "Tear down". It asks you to
type the app's name, then "Tear it down" to confirm. Tear down the other one from the
command line; it asks before it does anything, so type `y`:

```bash
sealeye teardown static-website
```

When you are done, `sealeye list` and the website should both show nothing live of
yours.

## If something goes wrong

Run `sealeye doctor` first: it checks what this machine needs and says what to fix.
Then note the deployment id (it starts with `dep_`, and `sealeye list --deployments`
shows them), take a screenshot, and send both to Greg.

## What seaLeye keeps

seaLeye sends a copy of your app's folder to the platform to read and build it. It
never sends `.env` files or other files that hold secrets, only their names. It also
checks your code for values that look like secrets, a key written into a file say: a
line with one is not sent (the rest of the file is), and a deploy is refused until the value moves
into a setting (`sealeye settings set <NAME>`), or a line in `.sealeye-allow` says it is
not a secret. Files your `.gitignore` leaves out are not sent at all. The sample apps have none. For these
sample apps, each interview is recorded so it can be improved: the questions, your
answers and the plan, never the contents of your files. `sealeye run --no-trace` turns
that off for a run.
