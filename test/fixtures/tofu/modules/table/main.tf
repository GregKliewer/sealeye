# A table an app uses, as a platform library writes one: it makes the policy that grants
# the app access and offers it as an output, so a root module only connects outputs to
# inputs (scripts/tofu-check.js).
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.60"
    }
  }
}

variable "name" {
  description = "The app's name."
  type        = string
}

variable "stage" {
  description = "Which stage this is."
  type        = string
}

variable "tags" {
  description = "Extra tags."
  type        = map(string)
  default     = {}
}

resource "aws_dynamodb_table" "table" {
  name         = "${var.name}-${var.stage}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"
  tags         = var.tags

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_iam_policy" "read_write" {
  name = "${var.name}-${var.stage}-table-read-write"
  policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem"], Resource = aws_dynamodb_table.table.arn }]
  })
}

output "table_name" {
  description = "The table."
  value       = aws_dynamodb_table.table.name
}

output "access_policy_arn" {
  description = "Reads and writes the table."
  value       = aws_iam_policy.read_write.arn
}
