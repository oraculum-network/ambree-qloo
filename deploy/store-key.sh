#!/usr/bin/env bash
# Store the Qloo API key in Secret qloo/qloo-api (key QLOO_API_KEY), run on the host.
#
#   bash deploy/store-key.sh                 # hidden prompt
#   security find-generic-password -s oraculum-qloo -a travelbook -w |
#     ssh <admin>@<host> "sudo env KUBECTL='k3s kubectl' bash -c $(printf %q "$(cat deploy/store-key.sh)") store-key"
#
# The key comes from a hidden prompt on a terminal, else one line on stdin (the rest of
# stdin is ignored). It never goes in argv, an echo or a log: it reaches kubectl on stdin
# only. The Secret is created empty if missing, then patched (never `kubectl apply`: apply
# copies the whole object, key included, into the last-applied-configuration annotation,
# which `describe` prints).
# Then: kubectl -n qloo rollout restart deployment/qloo-web
#
# KUBECTL is the kubectl command, split on spaces ("k3s kubectl" on the host; the tests use
# a fake). Needs jq.

set -euo pipefail

read -r -a KUBECTL_CMD <<<"${KUBECTL:-kubectl}"
NS="qloo"
SECRET="qloo-api"
KEY_NAME="QLOO_API_KEY"

k=""
if [ -t 0 ]; then
  printf 'Qloo API key (hidden): ' >&2
  IFS= read -rs k || true
  printf '\n' >&2
else
  IFS= read -r k || true
fi
k="${k%$'\r'}"
if [ -z "$k" ]; then
  echo "store-key: no key given, nothing stored" >&2
  exit 2
fi

if ! "${KUBECTL_CMD[@]}" -n "$NS" get secret "$SECRET" -o name >/dev/null 2>&1; then
  "${KUBECTL_CMD[@]}" -n "$NS" create secret generic "$SECRET" >/dev/null
fi

printf '%s' "$k" \
  | "${KUBECTL_CMD[@]}" -n "$NS" create secret generic "$SECRET" --from-file="$KEY_NAME"=/dev/stdin --dry-run=client -o json \
  | jq '{data}' \
  | "${KUBECTL_CMD[@]}" -n "$NS" patch secret "$SECRET" --patch-file /dev/stdin >/dev/null
unset k

echo "store-key: stored $KEY_NAME in secret $NS/$SECRET."
echo "Next: ${KUBECTL_CMD[*]} -n $NS rollout restart deployment/qloo-web, then the smoke check in DEPLOY.md."
