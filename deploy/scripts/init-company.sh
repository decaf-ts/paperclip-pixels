#!/usr/bin/env bash
# Declarative first-company + relay-feed configuration bootstrap.
#
# Wires the two-plugin deployment's worker->feed relay push so it is active
# WITHOUT any manual per-company UI step. The chart mounts the company config
# (from `initialCompany.config`) at /paperclip/instances/default/company-init.yaml;
# this script consumes that file and, against a running Paperclip API:
#
#   1. discovers (or is told) the company id;
#   2. registers the feed bearer token as a company secret when
#      PAPERCLIP_PIXEL_FEED_TOKEN is provided (so the relay has a real
#      secret_ref to bind, never a plaintext value);
#   3. POSTs the plugin's company-scoped config
#      { companyId, configJson: { pixelAgentsUrl, pixelAgentsTokenRef,
#        pixelAgentsAllowedHttpHosts } } to POST /api/plugins/:pluginId/config
#      (the route's required body shape -- see paperclip/server/src/routes/plugins.ts).
#
# Idempotent: re-running with the same inputs upserts the same config and does
# not duplicate secrets.
#
# Why this is a one-time (post first company) step and not part of host first
# boot: plugin config is company-scoped and a FRESH deployment has no company
# yet (creation needs the human board-claim / sign-up or the operator's own
# company import). Run it ONCE after the first company exists.
#
# Usage:
#   PAPERCLIP_PIXEL_FEED_URL=http://pixel-agents:8081 \
#   PAPERCLIP_PIXEL_FEED_TOKEN=<shared-secret> \
#   PAPERCLIP_PIXEL_TOKEN_SECRET_NAME=paperclip-pixel-feed-token \
#     deploy/scripts/init-company.sh [paperclip-base-url] [plugin-id] [company-id]
#
# Inputs (env, all optional -- company-id may also be the 3rd positional arg).
# NOTE: these deliberately use a PIXELS_ prefix so they never collide with the
# Paperclip runtime's own PAPERCLIP_* env vars (PAPERCLIP_COMPANY_ID etc. are
# set by the host and would otherwise be picked up as a deployment input).
#   PAPERCLIP_COMPANY_INIT_FILE        company-init yaml path (chart sets this)
#   PIXELS_BASE_URL / arg1             paperclip base url
#   PIXELS_PLUGIN_ID / arg2            plugin id (default paperclip-pixel.paperclip-plugin)
#   PIXELS_COMPANY_ID / arg3           explicit company id (else auto-discovered by slug/name)
#   PAPERCLIP_PIXEL_FEED_URL           feed URL (http://pixel-agents:8081 or https://<svc>-pixel-agents:8081)
#   PAPERCLIP_PIXEL_FEED_TOKEN         shared feed bearer token (to register as a company secret)
#   PAPERCLIP_PIXEL_TOKEN_SECRET_NAME  company secret name (default paperclip-pixel-feed-token)
#   PAPERCLIP_PIXEL_TOKEN_REF          explicit tokenRef overriding secret creation (advanced)
#   PAPERCLIP_PIXEL_ALLOWED_HTTP_HOSTS comma-separated cleartext http hosts
set -euo pipefail

BASE="${1:-${PIXELS_BASE_URL:-http://127.0.0.1:3100}}"
PLUGIN_ID="${2:-${PIXELS_PLUGIN_ID:-paperclip-pixel.paperclip-plugin}}"
COMPANY_ID="${3:-${PIXELS_COMPANY_ID:-}}"
CONFIG="${PAPERCLIP_COMPANY_INIT_FILE:-/paperclip/instances/default/company-init.yaml}"

FEED_URL="${PAPERCLIP_PIXEL_FEED_URL:-}"
FEED_TOKEN="${PAPERCLIP_PIXEL_FEED_TOKEN:-}"
TOKEN_SECRET_NAME="${PAPERCLIP_PIXEL_TOKEN_SECRET_NAME:-paperclip-pixel-feed-token}"
TOKEN_REF_OVERRIDE="${PAPERCLIP_PIXEL_TOKEN_REF:-}"

# Load the company-init yaml into JSON (company slug/name + optional relay
# fields). We deliberately avoid js-yaml (not guaranteed in every runtime) and
# parse the deployment's own simple YAML shape: top-level `key: value` scalars
# and a `pixelAgentsAllowedHttpHosts:` `- item` list. A missing/unparseable
# file degrades to {} and the script then relies on env-only inputs.
COMPANY_JSON="$(node -e '
const fs=require("fs");
let c={};
try {
  const p=process.argv[1];
  if (fs.existsSync(p)) {
    c=parseCompanyYaml(fs.readFileSync(p,"utf8"));
  }
} catch(e) { c={}; }
function parseCompanyYaml(text){
  const out={}; const lines=text.split(/\r?\n/);
  const scalar=/^([A-Za-z0-9_.-]+):\s*(.*?)\s*$/;
  const listItem=/^\s*-\s+(.+?)\s*$/;
  let currentListKey=null;
  for(const line of lines){
    if(/^\s*#/.test(line)||!/\S/.test(line)){ currentListKey=null; continue; }
    const li=line.match(listItem);
    if(li){
      if(currentListKey){ out[currentListKey].push(li[1].replace(/^["\x27]|["\x27]$/g,"")); }
      continue;
    }
    const m=line.match(scalar);
    if(m){
      const key=m[1]; let val=m[2];
      val=val.replace(/\s+#.*$/,"").trim();
      if(val===""||val==="null"){
        // empty value: could be a scalar-null or the head of a `- item` list.
        // We cannot know until the next line, so scaffold a list and let it
        // collapse to {} if no item follows.
        out[key]=[]; currentListKey=key;
      } else {
        out[key]=val.replace(/^["\x27]|["\x27]$/g,""); currentListKey=null;
      }
      continue;
    }
  }
  // Collapse zero-item lists (a scalar that was followed by something else).
  for(const k of Object.keys(out)){ if(Array.isArray(out[k])&&out[k].length===0){ delete out[k]; } }
  return out;
}
process.stdout.write(JSON.stringify(c));
' "$CONFIG")"

json_get() { node -e '
const fs=require("fs");let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  try{const o=JSON.parse(d||"{}");const path=process.argv[1].replace(/^\.+/,"").split(".").filter(Boolean);let v=o;
    for(const k of path){ if(v==null){break;} v=v[k]; }
    process.stdout.write(v===undefined||v===null?"":String(v));
  }catch(e){}
});' "$1"; }

json_arr() { node -e '
const fs=require("fs");let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  try{const o=JSON.parse(d||"{}");const path=process.argv[1].replace(/^\.+/,"").split(".").filter(Boolean);let v=o;
    for(const k of path){ if(v==null){break;} v=v[k]; }
    process.stdout.write(JSON.stringify(Array.isArray(v)?v:[]));
  }catch(e){process.stdout.write("[]");}
});' "$1"; }

company_slug="$(printf '%s' "$COMPANY_JSON" | json_get '.slug')"
[ -z "${company_slug}" ] && company_slug="$(printf '%s' "$COMPANY_JSON" | json_get '.name')"

# Determine the company id: explicit arg/env -> company-init id -> companies
# list (match by slug/name, or fall back to the single company).
if [ -z "${COMPANY_ID}" ]; then
  id_from_init="$(printf '%s' "$COMPANY_JSON" | json_get '.id')"
  if [ -n "${id_from_init}" ]; then
    COMPANY_ID="${id_from_init}"
  else
    if [ -n "${company_slug}" ]; then
      echo "==> discovering company '${company_slug}'" >&2
    else
      echo "==> discovering the single/active company" >&2
    fi
    COMPANIES="$(curl -fsS "${BASE}/api/companies" -H 'accept: application/json' 2>/dev/null || printf '{"companies":[]}')"
    COMPANY_ID="$(printf '%s' "$COMPANIES" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  try{
    const slug=process.argv[1];const arr=JSON.parse(d||"{}");
    const list=Array.isArray(arr)?arr:(arr.companies||[]);
    const hit=list.find(x=>x&&(x.slug===slug||x.name===slug));
    if(hit&&hit.id){process.stdout.write(hit.id);}
    else if(list.length===1&&list[0].id){process.stdout.write(list[0].id);}
  }catch(e){}
});' "$company_slug")"
  fi
fi

if [ -z "${COMPANY_ID}" ]; then
  echo "ERROR: could not determine company id. Pass it as the 3rd argument or set PIXELS_COMPANY_ID." >&2
  exit 2
fi

# Resolve feed URL (env wins over company-init).
if [ -z "${FEED_URL}" ]; then
  FEED_URL="$(printf '%s' "$COMPANY_JSON" | json_get '.pixelAgentsUrl')"
fi
if [ -z "${FEED_URL}" ]; then
  echo "ERROR: no feed URL. Set PAPERCLIP_PIXEL_FEED_URL (or pixelAgentsUrl in the company-init file)." >&2
  exit 2
fi

# Allowed cleartext http hosts (env wins over company-init).
ALLOWED_HTTP="$(printf '%s' "$COMPANY_JSON" | json_arr '.pixelAgentsAllowedHttpHosts')"
if [ -n "${PAPERCLIP_PIXEL_ALLOWED_HTTP_HOSTS:-}" ]; then
  ALLOWED_HTTP="$(printf '%s' "$PAPERCLIP_PIXEL_ALLOWED_HTTP_HOSTS" | node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  process.stdout.write(JSON.stringify(d.split(",").map(s=>s.trim()).filter(Boolean)));
});')"
fi

# Register the feed token as a company secret (when provided) and build a tokenRef.
TOKEN_REF="${TOKEN_REF_OVERRIDE:-}"
if [ -z "${TOKEN_REF}" ] && [ -n "${FEED_TOKEN}" ]; then
  echo "==> registering feed token secret '${TOKEN_SECRET_NAME}' in company ${COMPANY_ID}" >&2
  SECRET_ID="$(curl -fsS -X POST "${BASE}/api/companies/${COMPANY_ID}/secrets" \
    -H 'content-type: application/json' \
    -d "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],key:process.argv[1],value:process.argv[2]}));' "$TOKEN_SECRET_NAME" "$FEED_TOKEN")" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{try{const o=JSON.parse(d);process.stdout.write(o.id||"");}catch(e){}});' || true)"
  if [ -z "${SECRET_ID}" ]; then
    echo "ERROR: could not create/register the feed token secret." >&2
    exit 2
  fi
  TOKEN_REF="$(node -e 'process.stdout.write(JSON.stringify({type:"secret_ref",secretId:process.argv[1],version:"latest"}));' "$SECRET_ID")"
fi

# Apply the company-scoped plugin config.
PAYLOAD="$(node -e '
const companyId=process.argv[1],url=process.argv[2],tokenRef=process.argv[3],allowed=process.argv[4];
const configJson={pixelAgentsUrl:url,pixelAgentsAllowedHttpHosts:JSON.parse(allowed)};
if (tokenRef) configJson.pixelAgentsTokenRef=JSON.parse(tokenRef);
process.stdout.write(JSON.stringify({companyId,configJson}));
' "$COMPANY_ID" "$FEED_URL" "$TOKEN_REF" "$ALLOWED_HTTP")"

echo "==> applying plugin config to ${PLUGIN_ID} (company ${COMPANY_ID})"
curl -fsS -X POST "${BASE}/api/plugins/${PLUGIN_ID}/config" \
  -H 'content-type: application/json' \
  -d "${PAYLOAD}" \
  && echo "   plugin config applied"
