# Automated publishing and deployment

- GitHub: https://github.com/michael-git-repo/k8-microservices
- Docker Hub: https://hub.docker.com/r/bleosas/products-service
- Cluster: `microservices` in WSL `Ubuntu-24.04`
- Application namespace: `microservices`
- Argo CD namespace: `argocd` (installed from official release v3.5.3)

## What happens after a push

1. A push to `main` affecting `app/`, `scripts/`, `security/`, or the workflow
   starts GitHub Actions. Pull requests run validation without publishing.
2. Actions runs the API tests and deployment-update tests, builds the image,
   and scans it with Trivy. High or critical vulnerabilities fail the run.
3. The publishing job downloads the exact tested image and pushes
   `bleosas/products-service:sha-<source-commit>` to Docker Hub.
4. The job records the published image's immutable digest in
   `k8s/deployment.yaml` and commits that change to `main` as `github-actions[bot]`.
   It skips this update if a newer commit has already reached `main`.
5. Argo CD polls this public repository and applies changes in `k8s/` to the
   cluster. Automated synchronization and self-healing are enabled. Automatic
   deletion of resources removed from Git is disabled (`prune: false`).

The bot's commit uses the repository's `GITHUB_TOKEN`, so it does not trigger
another Actions run. Changes to Kubernetes manifests alone are picked up by
Argo CD without rebuilding the app. A workflow may also be started manually
from the Actions tab; publishing is limited to the `main` branch.

The existing SQLite volume is reused on rollout. The single-replica Recreate
strategy causes a brief interruption during each app deployment.

## Credentials

The repository's Actions secrets are:

| Secret | Value |
| --- | --- |
| `USERNAME` | Docker Hub username `bleosas` |
| `DOCKER_TOKEN` | Docker Hub personal access token with Read and Write permissions |

Token values stay in GitHub Secrets. The publishing job uses the automatic
`GITHUB_TOKEN` with `contents: write` to update the deployment manifest. The
validation job only has read access. No cluster credentials are uploaded to
GitHub; Argo CD fetches changes from inside the local cluster.

## Make a code change

From this repository in WSL Ubuntu:

```bash
git pull --ff-only origin main
# Edit the application, then:
git add app/src
git commit -m "Update products service"
git push origin main
```

Pull before editing so your working copy includes the previous deployment
commit written by the workflow. Keep Docker Desktop and the kind cluster
running for Argo CD to deploy. If they are stopped, image publishing can still
finish on GitHub, and Argo CD catches up when the cluster resumes.

## Check progress

```bash
gh run list --repo michael-git-repo/k8-microservices --limit 5
export KUBECONFIG="$HOME/.kube/microservices.yaml"
kubectl -n argocd get applications
kubectl -n microservices get pods,svc,pvc
kubectl -n microservices rollout status deployment/products-service
```

The Argo CD Application should show `Synced` and `Healthy`. Its polling cycle
can take a few minutes after a commit. To request an immediate refresh:

```bash
kubectl -n argocd annotate application products-service argocd.argoproj.io/refresh=hard --overwrite
```

## Open the app and Argo CD

For the products API:

```bash
kubectl -n microservices port-forward service/products-service 18080:80
```

Open http://localhost:18080/products. Port-forwarding connects to a particular
pod; restart it after a rollout if the connection stops working.

For the Argo CD UI, use another terminal:

```bash
kubectl -n argocd port-forward service/argocd-server 18443:443
```

Open https://localhost:18443. This local installation uses a self-signed TLS
certificate. The initial username is `admin`; retrieve the initial password
locally with:

```bash
kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' | base64 -d
```

Change that password in Argo CD after signing in. Do not commit credentials.

## Reinstall the Argo CD application

Once Argo CD is installed, run from the repository root:

```bash
kubectl apply -f argocd/application.yaml
```

For a fresh Argo CD installation, create its namespace and install the pinned
official manifest first:

```bash
kubectl create namespace argocd
kubectl apply --server-side -n argocd -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.3/manifests/install.yaml
```

References: [Docker Hub tokens](https://docs.docker.com/security/access-tokens/personal-access-tokens/),
[Argo CD automated sync](https://argo-cd.readthedocs.io/en/stable/user-guide/auto_sync/),
[GitHub token behavior](https://docs.github.com/en/actions/concepts/security/github_token).
