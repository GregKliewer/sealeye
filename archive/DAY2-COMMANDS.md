#Progress - day 2 commands

Panel: Fri Oct 2, 2026. Code freeze: Sun Sept 27, 2026.
Last updated: Sun Sept 20, 2026.

## Path Used
Adapter

## Commands Used

time aws cloudformation deploy \
  --template-file templates/http_api_serverless.yaml \
  --stack-name dep-sample-expressjs \
  --parameter-overrides AppName=sample-expressjs \
      ArtifactBucket=${DEPLOYME_BUCKET} ArtifactKey=sample-expressjs/v1.zip \
      AdapterLayerVersion=${DEPLOYME_LWA_VERSION} RetentionDays=30 \
  --capabilities CAPABILITY_NAMED_IAM

0.27s user 0.08s system 0% cpu 1:06.53 total

time (aws cloudformation delete-stack --stack-name dep-sample-expressjs && \
      aws cloudformation wait stack-delete-complete --stack-name dep-sample-expressjs)

0.22s user 0.07s system 0% cpu 31.354 total


time aws cloudformation deploy --template-file templates/static_site_edge.yaml \
  --stack-name dep-static-website --parameter-overrides AppName=static-website

0.27s user 0.09s system 0% cpu 36.509 total

aws s3 sync apps/static-website "s3://${SITE_BUCKET}" --delete
aws cloudformation delete-stack --stack-name dep-static-website && \
  aws cloudformation wait stack-delete-complete --stack-name dep-static-website


## Added Sept 20 evening (the parts the executor also needs)

### Values in .env (not secrets)
DEPLOYME_BUCKET = deployme-artifacts-<account>-ca-central-1 (artifact bucket, created with `aws s3 mb`)
DEPLOYME_LWA_VERSION = 28 (LambdaAdapterLayerX86, from the awslabs README; list-layer-versions is denied on the public layer)
Region ca-central-1. Runtime nodejs20.x. Architecture x86_64.

### Packaging (exactly what the executor must do, never touching the app folder)
rm -rf dist/stage && mkdir -p dist/stage
rsync -a --exclude node_modules --exclude .git --exclude .do --exclude .github apps/sample-expressjs/ dist/stage/
(cd dist/stage && npm install --omit=dev --no-audit --no-fund)
cp templates/run.sh dist/stage/run.sh && chmod +x dist/stage/run.sh
rm -f dist/sample-expressjs.zip
(cd dist/stage && zip -qr ../sample-expressjs.zip .)
aws s3 cp dist/sample-expressjs.zip "s3://${DEPLOYME_BUCKET}/sample-expressjs/v1.zip"
# run.sh must be executable BEFORE zipping; zip preserves the bit. Lost bit = "Permission denied" in the logs.
# Artifact key convention used today: <app>/v<n>.zip. Executor should use <app>/<deploymentId>.zip.

### Reading the result (executor: outputs -> report)
aws cloudformation describe-stacks --stack-name dep-sample-expressjs \
  --query "Stacks[0].Outputs[].[OutputKey,OutputValue]" --output table
URL=$(aws cloudformation describe-stacks --stack-name dep-sample-expressjs \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)
curl -s "$URL/"
aws logs tail /aws/lambda/sample-expressjs --since 10m
# Outputs: ApiUrl, FunctionName, LogGroup. Read them fresh after every deploy: a deleted-and-recreated
# stack gets a NEW API id (a stale URL returns {"message":"Not Found"}); an update to a live stack keeps it.

### Update in place (second deploy = update, same URL)
sed -i '' 's/Hello World!/Hello from deployme v2/' dist/stage/index.js   # stands in for the developer editing the app
rm -f dist/sample-expressjs.zip && (cd dist/stage && zip -qr ../sample-expressjs.zip .)
aws s3 cp dist/sample-expressjs.zip "s3://${DEPLOYME_BUCKET}/sample-expressjs/v2.zip"
aws cloudformation deploy --template-file templates/http_api_serverless.yaml --stack-name dep-sample-expressjs \
  --parameter-overrides AppName=sample-expressjs ArtifactBucket=${DEPLOYME_BUCKET} ArtifactKey=sample-expressjs/v2.zip \
      AdapterLayerVersion=${DEPLOYME_LWA_VERSION} RetentionDays=30 --capabilities CAPABILITY_NAMED_IAM
# Result: did the v2 greeting appear at the same URL? yes
# Update time: 0.27s user 0.08s system 0% cpu 36.553 total

### Static site (bucket must be emptied before the stack can be deleted)
SITE_BUCKET=$(aws cloudformation describe-stacks --stack-name dep-static-website \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)
aws s3 sync apps/static-website "s3://${SITE_BUCKET}" --delete
SITE_URL=$(aws cloudformation describe-stacks --stack-name dep-static-website \
  --query "Stacks[0].Outputs[?OutputKey=='WebsiteUrl'].OutputValue" --output text)   # http://, not https
aws s3 rm "s3://${SITE_BUCKET}" --recursive          # executor's destroy must do this first for static
aws cloudformation delete-stack --stack-name dep-static-website && \
  aws cloudformation wait stack-delete-complete --stack-name dep-static-website
# Account-level Block Public Access: no change was needed (bucket-level settings in the template were enough).

### Timings recorded today
API stack create: 1:06 (first create). Delete: 31 s. Static stack create: 37 s.
Second API create: <fill in, if you timed the redeploy>

### Failure states seen today and what they meant
- {"message":"Not Found"} in the browser after delete + redeploy: stale URL, not a routing problem. Re-read outputs.
- Status states the executor must map: CREATE_IN_PROGRESS / UPDATE_IN_PROGRESS -> running;
  CREATE_COMPLETE / UPDATE_COMPLETE -> succeeded; anything containing ROLLBACK or FAILED -> failed
  (surface the first CREATE_FAILED reason from describe-stack-events); DELETE_IN_PROGRESS -> destroying.
