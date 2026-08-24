#!/usr/bin/env bash
set -euo pipefail

coturn_is_active() {
  systemctl is-active --quiet coturn
}

restart_coturn() {
  systemctl restart coturn
}

stop_coturn() {
  systemctl stop coturn >/dev/null 2>&1 || true
}

verify_live_tls() {
  local hostname="$1"
  timeout 10 openssl s_client -connect 127.0.0.1:443 \
    -servername "$hostname" -verify_hostname "$hostname" \
    -verify_return_error -CAfile /etc/ssl/certs/ca-certificates.crt \
    </dev/null >/dev/null 2>&1
}

prepare_candidate_directory() {
  local directory="$1"
  chown root:turnserver "$directory"
  chmod 0750 "$directory"
}

new_public_key_temporary_file() {
  local label="$1"
  mktemp "/run/classpilot-turn-$label-public.XXXXXX"
}

install_candidate_file() {
  local source_path="$1"
  local destination_path="$2"
  install -m 0640 -o root -g turnserver "$source_path" "$destination_path"
}

candidate_is_readable() {
  local directory="$1"
  runuser -u turnserver -- test -r "$directory/fullchain.pem" &&
    runuser -u turnserver -- test -r "$directory/privkey.pem"
}

validate_candidate_material() {
  local directory="$1"
  local hostname="$2"
  local certificate_public_key="$3"
  local private_public_key="$4"

  openssl x509 -in "$directory/fullchain.pem" -noout \
    -checkhost "$hostname" >/dev/null
  openssl x509 -in "$directory/fullchain.pem" -noout \
    -checkend 86400 >/dev/null
  openssl pkey -in "$directory/privkey.pem" -check -noout >/dev/null 2>&1
  openssl x509 -in "$directory/fullchain.pem" -pubkey -noout \
    >"$certificate_public_key"
  openssl pkey -in "$directory/privkey.pem" -pubout \
    >"$private_public_key"
  cmp -s "$certificate_public_key" "$private_public_key"
  test "$(stat -c '%a:%U:%G' "$directory/fullchain.pem")" = '640:root:turnserver'
  test "$(stat -c '%a:%U:%G' "$directory/privkey.pem")" = '640:root:turnserver'
  candidate_is_readable "$directory"
}

remove_release_directory() {
  local directory="$1"
  test -d "$directory" || return 0
  rm -f -- "$directory/fullchain.pem" "$directory/privkey.pem"
  rmdir -- "$directory"
}

atomic_switch_current() {
  local tls_root="$1"
  local target="$2"
  local temporary_link="$tls_root/.current.$$.${RANDOM}"
  ln -s "$target" "$temporary_link"
  mv -Tf -- "$temporary_link" "$tls_root/current"
}

current_link_exists() {
  test -L "$1/current"
}

current_path_exists() {
  test -e "$1/current"
}

read_current_target() {
  readlink "$1/current"
}

current_material_directory() {
  printf '%s/current\n' "$1"
}

remove_current_link() {
  rm -f -- "$1/current"
}

prune_old_releases() {
  local tls_root="$1"
  local current_target="$2"
  local previous_target="$3"
  local directory relative

  for directory in "$tls_root"/releases/release-*; do
    test -d "$directory" || continue
    relative="releases/${directory##*/}"
    if test "$relative" = "$current_target" || test "$relative" = "$previous_target"; then
      continue
    fi
    remove_release_directory "$directory"
  done
}

restore_previous_release() {
  local tls_root="$1"
  local previous_target="$2"
  local hostname="$3"

  if test -n "$previous_target"; then
    if ! atomic_switch_current "$tls_root" "$previous_target"; then
      stop_coturn
      return 1
    fi
    if ! restart_coturn || ! verify_live_tls "$hostname"; then
      stop_coturn
      return 1
    fi
  else
    remove_current_link "$tls_root"
    stop_coturn
  fi
}

deploy_certificate() (
  set -euo pipefail
  local hostname="$1"
  local lineage="$2"
  local tls_root="$3"
  local candidate_dir certificate_public_key private_public_key
  local release_name release_dir previous_target="" current_target
  local was_active=false

  candidate_dir="$(mktemp -d "$tls_root/releases/.candidate.XXXXXX")"
  certificate_public_key="$(new_public_key_temporary_file certificate)"
  private_public_key="$(new_public_key_temporary_file private-key)"
  # shellcheck disable=SC2329 # Invoked by the EXIT trap below.
  cleanup_candidate() {
    rm -f -- "$certificate_public_key" "$private_public_key"
    if test -d "$candidate_dir"; then
      remove_release_directory "$candidate_dir"
    fi
  }
  trap cleanup_candidate EXIT

  prepare_candidate_directory "$candidate_dir"
  install_candidate_file "$lineage/fullchain.pem" "$candidate_dir/fullchain.pem"
  install_candidate_file "$lineage/privkey.pem" "$candidate_dir/privkey.pem"
  if ! validate_candidate_material \
    "$candidate_dir" "$hostname" "$certificate_public_key" "$private_public_key"; then
    return 1
  fi

  if current_link_exists "$tls_root"; then
    previous_target="$(read_current_target "$tls_root")"
    case "$previous_target" in
      releases/release-*) ;;
      *) return 1 ;;
    esac
    test -d "$tls_root/$previous_target"
  elif current_path_exists "$tls_root"; then
    return 1
  fi
  if coturn_is_active; then
    was_active=true
  fi

  release_name="release-$(basename "$candidate_dir" | cut -d. -f3)"
  release_dir="$tls_root/releases/$release_name"
  mv -- "$candidate_dir" "$release_dir"
  candidate_dir="$release_dir"
  atomic_switch_current "$tls_root" "releases/$release_name"

  if ! candidate_is_readable "$(current_material_directory "$tls_root")"; then
    if test "$was_active" = true; then
      restore_previous_release "$tls_root" "$previous_target" "$hostname" || true
    elif test -n "$previous_target"; then
      atomic_switch_current "$tls_root" "$previous_target" || true
    else
      remove_current_link "$tls_root"
    fi
    remove_release_directory "$release_dir"
    candidate_dir=""
    return 1
  fi

  if test "$was_active" = true; then
    if ! restart_coturn || ! verify_live_tls "$hostname"; then
      restore_previous_release "$tls_root" "$previous_target" "$hostname" || true
      remove_release_directory "$release_dir"
      candidate_dir=""
      return 1
    fi
  fi

  current_target="releases/$release_name"
  rm -f -- "$certificate_public_key" "$private_public_key"
  candidate_dir=""
  trap - EXIT
  if ! prune_old_releases "$tls_root" "$current_target" "$previous_target"; then
    return 1
  fi
)

expected_lineage_path() {
  printf '/etc/letsencrypt/live/%s\n' "$1"
}

production_tls_root() {
  printf '/etc/coturn/tls\n'
}

main() {
  if test "$#" -ne 1 || [[ "$1" != turn-[ab].school-pilot.net ]]; then
    return 2
  fi
  local hostname="$1"
  local expected_lineage
  expected_lineage="$(expected_lineage_path "$hostname")"
  local renewed_lineage
  renewed_lineage="$(printenv RENEWED_LINEAGE 2>/dev/null || true)"
  if test -n "$renewed_lineage" && test "$renewed_lineage" != "$expected_lineage"; then
    return 0
  fi
  test -n "$renewed_lineage" || renewed_lineage="$expected_lineage"
  deploy_certificate "$hostname" "$renewed_lineage" "$(production_tls_root)"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
