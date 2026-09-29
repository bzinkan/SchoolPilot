# Legacy ClassPilot TURN parking: the module keeps every resource declared,
# enforces the node power state, and pins the image so parking never replaces
# a node.
mock_provider "aws" {
  override_during = plan
  mock_data "aws_ssm_parameter" {
    defaults = { value = "ami-0fffffffffffffff0", type = "String" }
  }
  mock_resource "aws_cloudformation_stack" {
    defaults = { outputs = { SecretArn = "arn:aws:secretsmanager:us-east-1:000000000000:secret:/schoolpilot/test/classpilot-turn-rest-AbCdEf" } }
  }
  mock_resource "aws_eip" {
    defaults = { public_ip = "198.51.100.10", id = "eipalloc-00000000000000000", allocation_id = "eipalloc-00000000000000000" }
  }
  mock_resource "aws_instance" {
    defaults = { id = "i-00000000000000000", arn = "arn:aws:ec2:us-east-1:000000000000:instance/i-00000000000000000" }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::000000000000:role/test", id = "test", name = "test" }
  }
  mock_resource "aws_iam_instance_profile" {
    defaults = { arn = "arn:aws:iam::000000000000:instance-profile/test", id = "test", name = "test" }
  }
  mock_resource "aws_security_group" {
    defaults = { id = "sg-00000000000000000", arn = "arn:aws:ec2:us-east-1:000000000000:security-group/sg-00000000000000000" }
  }
}

variables {
  project           = "schoolpilot"
  environment       = "test"
  aws_region        = "us-east-1"
  vpc_id            = "vpc-00000000000000000"
  public_subnet_ids = ["subnet-0aaaaaaaaaaaaaaaa", "subnet-0bbbbbbbbbbbbbbbb"]
  route53_zone_id   = "Z0000000000000000000"
  domain            = "example.test"
  tls_email         = "ops@example.test"
}

run "parked_nodes_stop_with_pinned_image_and_retained_identity" {
  command = plan

  module {
    source = "./modules/turn"
  }

  variables {
    parked = true
    ami_id = "ami-052355af2a014bd2c"
  }

  override_data {
    target = data.aws_subnet.turn["a"]
    values = { availability_zone = "us-east-1a" }
  }
  override_data {
    target = data.aws_subnet.turn["b"]
    values = { availability_zone = "us-east-1b" }
  }

  assert {
    condition     = alltrue([for key in ["a", "b"] : aws_ec2_instance_state.turn[key].state == "stopped"])
    error_message = "Parked legacy TURN must declare both nodes stopped."
  }
  assert {
    condition     = alltrue([for key in ["a", "b"] : aws_instance.turn[key].ami == "ami-052355af2a014bd2c"])
    error_message = "Both nodes must use the pinned, verified image."
  }
  assert {
    condition     = length(data.aws_ssm_parameter.ubuntu_ami) == 0
    error_message = "A pinned image must not read Canonical's moving Ubuntu parameter."
  }
  assert {
    condition = alltrue([for key in ["a", "b"] : (
      aws_cloudwatch_metric_alarm.node_status[key].actions_enabled == false &&
      aws_cloudwatch_metric_alarm.node_status[key].treat_missing_data == "notBreaching" &&
      aws_cloudwatch_metric_alarm.log_storage[key].actions_enabled == false &&
      aws_cloudwatch_metric_alarm.log_storage[key].treat_missing_data == "notBreaching"
    )])
    error_message = "Stopped nodes must not page on missing status or log-storage data."
  }
  assert {
    condition     = length(aws_eip.turn) == 2 && length(aws_eip_association.turn) == 2 && length(aws_route53_record.turn) == 2
    error_message = "Parking must retain both Elastic IPs, their associations and both DNS records."
  }
}

run "unparked_nodes_run_and_unpinned_environments_follow_the_moving_image" {
  command = plan

  module {
    source = "./modules/turn"
  }

  variables {
    parked = false
  }

  override_data {
    target = data.aws_subnet.turn["a"]
    values = { availability_zone = "us-east-1a" }
  }
  override_data {
    target = data.aws_subnet.turn["b"]
    values = { availability_zone = "us-east-1b" }
  }

  assert {
    condition     = alltrue([for key in ["a", "b"] : aws_ec2_instance_state.turn[key].state == "running"])
    error_message = "An unparked node must be declared running."
  }
  assert {
    condition     = length(data.aws_ssm_parameter.ubuntu_ami) == 1
    error_message = "Without a pinned image, a new environment reads the moving Ubuntu parameter."
  }
  assert {
    condition = alltrue([for key in ["a", "b"] : (
      aws_cloudwatch_metric_alarm.node_status[key].actions_enabled == true &&
      aws_cloudwatch_metric_alarm.node_status[key].treat_missing_data == "breaching"
    )])
    error_message = "Running nodes must keep their status alarms armed."
  }
}

run "rejects_an_unverified_image_value" {
  command = plan

  module {
    source = "./modules/turn"
  }

  variables {
    ami_id = "ubuntu-latest"
  }

  expect_failures = [var.ami_id]
}
