# Your local WSL Kubernetes cluster

The `microservices` kind cluster is running in WSL distribution `Ubuntu-24.04`
through Docker Desktop. It uses Kubernetes v1.35.0, the existing kind and kubectl
installations, and its own kubeconfig. Your previous Kubernetes contexts remain
in their original configuration file.

The products service is deployed in the `microservices` namespace with one replica
and a 1 GiB persistent volume. Its database is separate from `app/data/` and from
Docker Compose's database.

## Open the service

Open http://localhost:18080/ for the product dashboard. `/products` returns JSON.

A background port-forward was started for this setup. Port 8080 was already in
use, so this service uses 18080. Port-forwarding must be running for this address
to work; it is not an automatic Windows startup service.

If it stops after a reboot or pod replacement, start Docker Desktop, open Ubuntu,
and run:

```bash
export KUBECONFIG="$HOME/.kube/microservices.yaml"
kubectl -n microservices port-forward service/products-service 18080:80
```

Keep that terminal open. If port 18080 is already being forwarded successfully,
there is no need to start another copy. Its logs are in
`app/data/k8s-port-forward.log` and
`app/data/k8s-port-forward-error.log`, which are ignored by Git.

## Check the cluster

Run these commands in Ubuntu:

```bash
export KUBECONFIG="$HOME/.kube/microservices.yaml"
kubectl config set-context --current --namespace=microservices
kubectl get nodes
kubectl get pods,svc,pvc
kubectl logs deployment/products-service --tail=30
```

The export selects this cluster for the current shell. Its connection file is
`/home/michael_ubuntu/.kube/microservices.yaml`; keep that file outside Git.

## Deploy code changes

GitHub Actions publishes images and Argo CD deploys them. From Ubuntu:

```bash
cd "/mnt/c/Users/USER/Downloads/k8 micro services"
git pull --ff-only origin main
# Make your application changes, then:
git add app/src app/public
git commit -m "Update products service"
git push origin main
```

See [CI_CD.md](CI_CD.md) for the pipeline, secret names, and Argo CD commands.
Restart port-forwarding after the pod is replaced. Keep the Deployment at one
replica while it uses SQLite. Data survives pod replacement, but deleting this
kind cluster removes the local storage holding its database.

The service was moved from `default` to `microservices` while its catalogue was
empty. The old `products-data` PVC in `default` is retained as a fallback; the
running service uses the PVC in `microservices`.

## Verified during setup

- Kubernetes node: Ready.
- Products service: one healthy running pod.
- Persistent volume claim: Bound, 1 GiB.
- Container image: built and loaded into kind successfully.
- Readiness endpoint: returned `ready` through the Windows localhost connection.
- API: created and retrieved a temporary product, then deleted it successfully.

Argo CD runs in the `argocd` namespace and watches the repository's `k8s/`
directory. The deployment image now comes from Docker Hub, rather than the
image that was initially loaded directly into kind.
