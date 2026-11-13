# Incident reporting to Jira

When the backend hits an unhandled error (an HTTP 500), it creates a Jira Task so the failure can be
triaged or picked up by an agent. This page explains the setup, how to trigger and validate it, and how
to debug it on Kubernetes.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<namespace>` | Kubernetes namespace the backend runs in (for example the dev namespace) |
| `<your-site>` | Your Jira Cloud site name, so the URL is `https://<your-site>.atlassian.net` |
| `<project-key>` | Jira project key the Tasks are created in |
| `<app-url>` | Base URL of the deployed app |
| `<atlassian-login-email>` | The Atlassian account email the API token belongs to |
| `<jira-api-token>` | The Jira API token (never commit it) |

## 1. Overview

- After the 500 response is sent, the backend reports the error to Jira. The report never delays or
  changes the response, and a Jira failure never breaks the request.
- Each error gets a **fingerprint**: the first 8 hex characters of a SHA-256 over the error name and the
  first stack frame that is not in `node_modules` (function and file name, no line numbers). The same
  bug keeps the same fingerprint across builds.
- The backend searches Jira for an **open** issue labelled `fp-<fingerprint>`.
  - Found: it adds a comment to that issue.
  - Not found: it creates a Task labelled `incident`, `auto-created` and `fp-<fingerprint>`.
- The Task title is `[auto] <ErrorName> in <METHOD /route> (<UTC timestamp>)`, for example
  `[auto] TypeError in GET /api/items/:id/badge (2026-11-12 13:45:07 UTC)`. The description holds the
  time, fingerprint, route, error, request ID, app version, git SHA, pod, spec hash, environment and stack.
- Each pod reports a given fingerprint at most once per 10 minutes (in memory), so a burst of identical
  errors does not flood Jira.
- **Former demo fault (fixed, SCRUM-15):** `GET /api/items/:id/badge` used to throw a `TypeError` for catalog
  items without a `tag` (Feature Flag Pack and Cost Insight Lens). Untagged items now return a badge without the tier,
  so `/api/items/3/badge` no longer returns a 500 and can't be used to trigger a demo incident.

## 2. Configuration reference

Reporting is on only when `INCIDENT_REPORTING=true` **and** all four Jira values are set, and the base
URL starts with `https://`. If anything is missing the backend just logs the error.

| Variable | Source | Example |
|---|---|---|
| `INCIDENT_REPORTING` | ConfigMap `backend-config` (overlay) | `true` |
| `JIRA_BASE_URL` | ConfigMap `backend-config` (overlay) | `https://<your-site>.atlassian.net` |
| `JIRA_PROJECT_KEY` | ConfigMap `backend-config` (overlay) | `<project-key>` |
| `JIRA_EMAIL` | Secret `jira-incident-credentials`, key `email` | `<atlassian-login-email>` |
| `JIRA_API_TOKEN` | Secret `jira-incident-credentials`, key `token` | `<jira-api-token>` |

The overlay in `k8s/overlays/dev/kustomization.yaml` sets the first three and wires the last two from the
secret (marked `optional`, so the pod still starts without it).

## 3. Setting the Jira email and API token

Jira Cloud does not accept an account password for the REST API. Use your Atlassian login **email** plus
an **API token**.

1. Create a token at <https://id.atlassian.com/manage-profile/security/api-tokens> and copy it.
2. The account that owns the token needs **Browse** and **Create** permission on the Jira project.
3. Create the Kubernetes secret (next section). Never commit the token or paste it into chat or tickets.

Optional: check the credentials directly against Jira before involving Kubernetes. Put the values in
environment variables so they do not end up in shell history as literals:

```
export JIRA_EMAIL='<atlassian-login-email>'
export JIRA_API_TOKEN='<jira-api-token>'
curl -s -u "$JIRA_EMAIL:$JIRA_API_TOKEN" https://<your-site>.atlassian.net/rest/api/3/myself
```

A JSON document with your account details means the email and token are valid. `401` means a wrong email
or token.

## 4. Secret setup runbook

### Step 1: check the secret exists, with the right keys

```
kubectl -n <namespace> get secret jira-incident-credentials
kubectl -n <namespace> describe secret jira-incident-credentials
```

The describe output should list two keys, `email` and `token`. It does not print their values.

### Step 2: if it is missing, create it

```
kubectl -n <namespace> create secret generic jira-incident-credentials \
  --from-literal=email='<atlassian-login-email>' \
  --from-literal=token='<jira-api-token>'
```

The key names must be `email` and `token` exactly. The email must be the one the API token was created
under.

To replace an existing secret, delete it and create it again:

```
kubectl -n <namespace> delete secret jira-incident-credentials
```

### Step 3: restart the pod so it picks up the secret

```
kubectl -n <namespace> rollout restart deploy/backend
kubectl -n <namespace> rollout status deploy/backend
```

Environment variables are only read when a pod starts, so creating the secret alone is not enough.

### Step 4: confirm reporting is on

```
kubectl -n <namespace> logs deploy/backend | grep listening
```

It should now show `"incidentReporting":true`.

## 5. How manifests reach the cluster

The Harness service (`spec_demo`) fetches its Kubernetes manifests from the **`main` branch**, folder
`k8s/overlays/<overlay>`, while the container image comes from the CI build of whatever branch the
pipeline ran on.

Consequences:

- A change to the overlay (env vars, secret wiring) only reaches the cluster after it is merged to `main`
  **and** the pipeline is run again. The PR trigger does not fire on a merge.
- If a pod runs new code with old manifests, the symptom is `"incidentReporting":false` and every
  variable in section 6 shows `EMPTY`, even when the secret exists.

## 6. Trigger the error

From the UI: open the Catalog and click **Copy badge**.

| Item | Result |
|---|---|
| Pipeline Starter Kit | badge text |
| Canary Deployer | badge text |
| Feature Flag Pack | red `internal server error` (reported to Jira) |
| Cost Insight Lens | red `internal server error` (reported to Jira) |

From the command line:

```
curl -i <app-url>/api/items/3/badge
```

Expect `HTTP 500` with `{"error":"internal server error"}`.

## 7. Validation checklist

Run these in order. Each one rules out a layer.

1. Pods and rollout are healthy:

   ```
   kubectl -n <namespace> get pods
   kubectl -n <namespace> rollout status deploy/backend
   ```

2. Reporting is enabled in the running process:

   ```
   kubectl -n <namespace> logs deploy/backend | grep listening
   ```

   Look for `"incidentReporting":true`. This line also shows `version` and `commit`, so you can confirm
   which build is running.

3. The secret exists and has both keys (step 1 of the runbook).

4. The variables reached the pod. This prints whether each is set, never the values:

   ```
   kubectl -n <namespace> exec deploy/backend -- sh -c 'for v in INCIDENT_REPORTING JIRA_BASE_URL JIRA_PROJECT_KEY JIRA_EMAIL JIRA_API_TOKEN; do eval "val=\$$v"; [ -n "$val" ] && echo "$v=set" || echo "$v=EMPTY"; done'
   ```

   Or inspect how the deployment is wired:

   ```
   kubectl -n <namespace> get deploy backend -o jsonpath='{.spec.template.spec.containers[0].env}{"\n"}{.spec.template.spec.containers[0].envFrom}{"\n"}'
   ```

5. Trigger the error (section 6), wait 5 to 10 seconds, then check that it was captured and whether
   reporting failed:

   ```
   kubectl -n <namespace> logs deploy/backend | grep -E "unhandled error|incident report failed"
   ```

   `unhandled error` without `incident report failed` means the report went out without an error.

6. Find the Task in Jira with this JQL (Filters, then Advanced search):

   ```
   project = <project-key> AND labels = "auto-created" ORDER BY created DESC
   ```

   Search results can lag by a few seconds. Open the Task to confirm the labels
   (`incident`, `auto-created`, `fp-<fingerprint>`) and the description.

7. Check the dedupe: click **Copy badge** on the same item again. Within 10 minutes nothing new is
   sent. After that, or after a pod restart, it adds a **comment** to the open Task instead of creating
   a new one.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `incidentReporting:false` and all variables `EMPTY` | Overlay changes are not on `main`, or the pipeline was not re-run after merging | Merge to `main`, run the pipeline, re-check (section 5) |
| `incidentReporting:false`, the three config variables are set, the two secret ones are `EMPTY` | Secret missing, a wrong key name, or the pod started before the secret existed | Runbook steps 1 to 4 |
| Everything `set` but still `false` | `INCIDENT_REPORTING` is not exactly `true`, or `JIRA_BASE_URL` does not start with `https://` | Fix the value and restart |
| `incident report failed ... status 401` | Wrong email or token, or a revoked token | Recreate the token and secret, restart |
| `incident report failed ... status 403` | The account has no permission on the project | Grant Browse and Create on the project |
| `incident report failed ... status 400` | Wrong project key, or the `Task` issue type does not exist in that project | Check `JIRA_PROJECT_KEY` and the project's issue types |
| `incident report failed ... status 410` | An outdated Jira search endpoint | Not expected: the code uses `/rest/api/3/search/jql` |
| `incident report failed ... aborted` | Jira did not answer within the 8 second timeout | Check egress and network policy from the pod to Jira |
| No ticket and no `incident report failed` | The same error was already reported by this pod in the last 10 minutes, or Jira search is lagging | Wait, restart the pod to clear the cooldown, or search Jira again |
| New error added a comment, not a Task | An open Task with the same `fp-` label exists | Expected; close the old Task to get a new one |

## 9. Temporary live patch for testing

Use this only to test before the manifests reach `main`. It changes the live deployment and restarts the
backend. The next Harness deployment overwrites it.

```
kubectl -n <namespace> patch deploy backend --type=strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"backend","env":[
{"name":"INCIDENT_REPORTING","value":"true"},
{"name":"JIRA_BASE_URL","value":"https://<your-site>.atlassian.net"},
{"name":"JIRA_PROJECT_KEY","value":"<project-key>"},
{"name":"JIRA_EMAIL","valueFrom":{"secretKeyRef":{"name":"jira-incident-credentials","key":"email"}}},
{"name":"JIRA_API_TOKEN","valueFrom":{"secretKeyRef":{"name":"jira-incident-credentials","key":"token"}}}
]}]}}}}'
kubectl -n <namespace> rollout status deploy/backend
kubectl -n <namespace> logs deploy/backend | grep listening
```

## 10. Cleanup and reset

- Close or delete the test Tasks in Jira.
- Clear the in-memory cooldown to test again from scratch:

  ```
  kubectl -n <namespace> rollout restart deploy/backend
  ```

- Turn reporting off by deleting the secret and restarting the backend, or by removing
  `INCIDENT_REPORTING` from the overlay:

  ```
  kubectl -n <namespace> delete secret jira-incident-credentials
  kubectl -n <namespace> rollout restart deploy/backend
  ```
