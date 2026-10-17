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
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.name))
    error_message = "name is lowercase letters, digits and hyphens, starting with a letter."
  }
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

variable "package_path" {
  description = "The zipped app."
  type        = string
}

variable "handler" {
  description = "The function the platform calls."
  type        = string
  default     = "index.handler"
}

variable "environment" {
  description = "Settings, names to values."
  type        = map(string)
  default     = {}
}

variable "permissions_boundary_arn" {
  description = "The platform's permissions boundary."
  type        = string
}

locals {
  full_name = "${var.name}-${var.stage}"
}

resource "aws_iam_role" "fn" {
  name                 = "${local.full_name}-api"
  permissions_boundary = var.permissions_boundary_arn
  tags                 = var.tags
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "lambda.amazonaws.com" } }]
  })
}

resource "aws_iam_role_policy_attachment" "logs" {
  role       = aws_iam_role.fn.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "fn" {
  name              = "/aws/lambda/${local.full_name}-api"
  retention_in_days = 7
  tags              = var.tags
}

resource "aws_lambda_function" "fn" {
  function_name    = "${local.full_name}-api"
  role             = aws_iam_role.fn.arn
  runtime          = "nodejs20.x"
  handler          = var.handler
  filename         = var.package_path
  source_code_hash = filebase64sha256(var.package_path)
  tags             = var.tags

  environment {
    variables = var.environment
  }

  depends_on = [aws_cloudwatch_log_group.fn]
}

resource "aws_apigatewayv2_api" "api" {
  name          = local.full_name
  protocol_type = "HTTP"
  tags          = var.tags
}

resource "aws_apigatewayv2_integration" "fn" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "all" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.fn.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}

output "url" {
  description = "The API's address."
  value       = aws_apigatewayv2_api.api.api_endpoint
}
