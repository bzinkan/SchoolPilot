run "disabled_accepts_empty_inputs" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = false
    has_managed_domain  = false
    public_subnet_count = 0
    tls_email           = ""
  }
}

run "enabled_rejects_missing_email" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = true
    has_managed_domain  = true
    public_subnet_count = 2
    tls_email           = ""
  }

  expect_failures = [terraform_data.activation]
}

run "enabled_rejects_malformed_email" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = true
    has_managed_domain  = true
    public_subnet_count = 2
    tls_email           = "not-an-email"
  }

  expect_failures = [terraform_data.activation]
}

run "enabled_rejects_shell_unsafe_email" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = true
    has_managed_domain  = true
    public_subnet_count = 2
    tls_email           = "operator'@school-pilot.invalid"
  }

  expect_failures = [terraform_data.activation]
}

run "enabled_rejects_missing_domain" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = true
    has_managed_domain  = false
    public_subnet_count = 2
    tls_email           = "operator@school-pilot.invalid"
  }

  expect_failures = [terraform_data.activation]
}

run "enabled_rejects_one_subnet" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = true
    has_managed_domain  = true
    public_subnet_count = 1
    tls_email           = "operator@school-pilot.invalid"
  }

  expect_failures = [terraform_data.activation]
}

run "enabled_accepts_complete_inputs" {
  command = plan

  module {
    source = "./modules/turn-activation-gate"
  }

  variables {
    enabled             = true
    has_managed_domain  = true
    public_subnet_count = 2
    tls_email           = "operator@school-pilot.invalid"
  }
}
