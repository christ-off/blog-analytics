#!/usr/bin/env bash
# One-time import of the console-created CloudFront logs bucket into the
# logs-bucket stack (eu-west-3). Creates a change set and shows it; it does
# NOT execute it. Review the output, then run the printed execute command.
#
# After the import, change the template and use:
#   aws cloudformation deploy --region eu-west-3 --stack-name logs-bucket \
#     --template-file infra/logs-bucket.yaml --parameter-overrides ...
set -euo pipefail

REGION=eu-west-3
STACK=logs-bucket
CHANGE_SET=import-existing-bucket
TEMPLATE="$(dirname "$0")/logs-bucket.yaml"

DISTRIBUTION_ID=E1Z5N5X273TPT1
LOGS_BUCKET=post-tenebras-lire-access-logs

aws cloudformation create-change-set \
  --region "$REGION" \
  --stack-name "$STACK" \
  --change-set-name "$CHANGE_SET" \
  --change-set-type IMPORT \
  --template-body "file://${TEMPLATE}" \
  --parameters \
    ParameterKey=LogsBucket,ParameterValue="$LOGS_BUCKET" \
    ParameterKey=DistributionId,ParameterValue="$DISTRIBUTION_ID" \
  --resources-to-import "[
    {\"ResourceType\":\"AWS::S3::Bucket\",\"LogicalResourceId\":\"Bucket\",\"ResourceIdentifier\":{\"BucketName\":\"${LOGS_BUCKET}\"}},
    {\"ResourceType\":\"AWS::S3::BucketPolicy\",\"LogicalResourceId\":\"BucketPolicy\",\"ResourceIdentifier\":{\"Bucket\":\"${LOGS_BUCKET}\"}}
  ]"

aws cloudformation wait change-set-create-complete \
  --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET"

aws cloudformation describe-change-set \
  --region "$REGION" --stack-name "$STACK" --change-set-name "$CHANGE_SET" \
  --query '{Status:Status,Changes:Changes[].ResourceChange.{Action:Action,Id:LogicalResourceId,Type:ResourceType}}'

cat <<EOT

Expected: two Import actions and nothing else. If so, execute with:

  aws cloudformation execute-change-set --region $REGION \\
    --stack-name $STACK --change-set-name $CHANGE_SET

Then check for drift (the imported properties must match the template):

  aws cloudformation detect-stack-drift --region $REGION --stack-name $STACK
EOT
