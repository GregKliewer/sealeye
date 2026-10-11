# Step 7: does an app read its settings from the store at start?

PHASE2-PLAN Step 7, before anything else in Part B is built. About half an hour, on your
Mac, from the repo root, signed in to the seaLeye account. It creates two test settings
and one throwaway function, runs it twice, and removes everything afterwards. The test
values are not secrets, and nothing ever prints a value: only names and lengths.

It answers five questions:

1. Can the start-up preload Step 10 will ship (`node --import`) load Lambda's own AWS SDK
   and read the app's folder? (`preload` lists `GREETING` and `API_TOKEN` with lengths
   above zero.)
2. Does an encrypted setting decrypt with no KMS permission on the function's role?
   (`API_TOKEN` has a length.)
3. Is the function kept to its own folder? (`otherApp` and `serverFolder` say
   `AccessDeniedException`.)
4. What does reading cost at start? (`preload.readMs`, cold and warm.)
5. Which Node runs it? (`node`.)

## 1. Two test settings for the app, one for another app

```bash
aws ssm put-parameter --region ca-central-1 --type SecureString --overwrite --query Version --output text \
  --name /sealeye-apps/spike/app-a/GREETING --value hello-from-the-store
aws ssm put-parameter --region ca-central-1 --type SecureString --overwrite --query Version --output text \
  --name /sealeye-apps/spike/app-a/API_TOKEN --value not-a-real-token-123
aws ssm put-parameter --region ca-central-1 --type SecureString --overwrite --query Version --output text \
  --name /sealeye-apps/spike/app-b/OTHER --value belongs-to-another-app
```

Success: three lines, each a version number.

## 2. The throwaway function

```bash
aws cloudformation deploy --region ca-central-1 \
  --template-file deploy/spikes/settings-read/template.yaml \
  --stack-name platform-sealeye-spike-settings --capabilities CAPABILITY_IAM
FN=$(aws cloudformation describe-stacks --region ca-central-1 --stack-name platform-sealeye-spike-settings \
  --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue" --output text)
echo "$FN"
```

Success: `Successfully created/updated stack`, then a function name.

## 3. Run it twice

```bash
for i in 1 2; do
  aws lambda invoke --region ca-central-1 --function-name "$FN" /dev/stdout --query StatusCode --output text
  echo
done
```

Each run prints one line of JSON, then `200`. Paste both JSON lines back to Claude. The
first should say `"wasCold":true`. What a good result looks like:

```json
{"node":"v20...","wasCold":true,"preload":{"names":[["GREETING",20],["API_TOKEN",20]],"readMs":"..."},"startMs":...,"sdkFound":true,"otherApp":"AccessDeniedException","serverFolder":"AccessDeniedException"}
```

## 4. Remove everything

```bash
aws cloudformation delete-stack --region ca-central-1 --stack-name platform-sealeye-spike-settings
aws ssm delete-parameters --region ca-central-1 --names \
  /sealeye-apps/spike/app-a/GREETING /sealeye-apps/spike/app-a/API_TOKEN /sealeye-apps/spike/app-b/OTHER \
  --query DeletedParameters --output text
```

Success: the three names, printed once.
