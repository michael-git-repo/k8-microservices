# Products microservice

A standalone HTTP service responsible for a product catalogue. It owns its
SQLite database and can be built and deployed independently. This is one
microservice; other services can call its API without accessing its database.

It includes product CRUD, validation, pagination, health probes, structured
request logs, Prometheus metrics, automated tests, Docker, and Kubernetes files.
There is no frontend and no external npm dependency.

## Run locally

Install Node.js 24.x. From the project root, in PowerShell:

```powershell
cd app
npm.cmd start
```

On macOS/Linux, use `npm start`. No `npm install` is needed. Open
http://localhost:3000/products to see the catalogue, initially empty. The root
URL returns service information. Stop the service with Ctrl+C.

The local database is `app/data/products.sqlite` when started from `app/`.
Products survive restarts. SQLite files and local environment files are ignored
by Git. Node 24.13 emits an experimental warning for its built-in SQLite module;
this does not prevent the service from running.

In another PowerShell terminal:

```powershell
$productBody = @{ name = 'Keyboard'; description = 'USB keyboard'; priceCents = 2499 } | ConvertTo-Json
$product = Invoke-RestMethod -Uri http://localhost:3000/products -Method Post -ContentType 'application/json' -Body $productBody
$product
Invoke-RestMethod -Uri http://localhost:3000/products
Invoke-RestMethod -Uri "http://localhost:3000/products/$($product.id)"

$replacementBody = @{ name = 'Keyboard Pro'; priceCents = 3499 } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:3000/products/$($product.id)" -Method Put -ContentType 'application/json' -Body $replacementBody
Invoke-RestMethod -Uri "http://localhost:3000/products/$($product.id)" -Method Delete
```

## HTTP API

| Method | Path | Result |
| --- | --- | --- |
| GET | `/` | Service information |
| GET | `/products?limit=20&offset=0` | `{ items, total, limit, offset }` |
| POST | `/products` | Create product; 201 with `Location` header |
| GET | `/products/{id}` | Retrieve product |
| PUT | `/products/{id}` | Replace name, description, and price |
| DELETE | `/products/{id}` | Delete product; 204 |
| GET | `/health/live` | Process health |
| GET | `/health/ready` | Database readiness; 503 when unavailable/draining |
| GET | `/metrics` | Prometheus text metrics |

POST and PUT accept `Content-Type: application/json` and this shape:

```json
{
  "name": "Keyboard",
  "description": "USB keyboard",
  "priceCents": 2499
}
```

`name` is required, trimmed, and limited to 120 characters. `priceCents` is a
required non-negative safe integer: 2499 means 24.99 in the catalogue's chosen
currency. `description` is optional, defaults to an empty string, and is limited
to 2000 characters. PUT replaces these fields; it is not a partial update.
Unknown fields are rejected. Request bodies are limited to 16 KiB. List limits
range from 1 to 100. Responses include UUID identifiers and UTC timestamps.

Errors use `{ "error": "message", "requestId": "uuid" }`. Status codes include
400 for validation, 404 for missing products/routes, 405 for unsupported methods,
413 for oversized requests, 415 for incorrect content types, and 500 for internal
failures. `X-Request-Id` links responses to the JSON request logs.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Bind address; containers use `0.0.0.0` |
| `PORT` | `3000` | HTTP port |
| `DB_PATH` | `data/products.sqlite` relative to working directory | SQLite file path |

Set environment variables in the shell; `.env` files are not loaded automatically.

## Tests

From `app/`:

```powershell
npm.cmd test
npm.cmd run test:coverage
```

Tests exercise real HTTP requests, the product lifecycle, invalid input, request
limits, pagination, health checks, metrics, error handling, draining, and durable
storage across application restarts. Tests use isolated databases and ephemeral
ports. Coverage reports cover the imported API and storage modules, not the
standalone startup script.

## Docker

Start Docker Desktop, then from the project root:

```powershell
docker compose up --build -d
docker compose logs -f products
```

The API is at http://localhost:3000. `docker compose down` stops it while retaining
the named data volume. The container runs as a non-root user with a read-only
root filesystem; `/data` is the writable database volume. Stop any native server
using port 3000 before starting Compose.

## Kubernetes

For the cluster already configured in your WSL Ubuntu environment, see
[LOCAL_CLUSTER.md](LOCAL_CLUSTER.md), including the running API on port 18080.
For automated publishing and deployment, see [CI_CD.md](CI_CD.md).

Use a cluster with a default StorageClass capable of provisioning a 1 GiB volume.
The manifests deploy one replica with a PVC and a ClusterIP service. SQLite uses
local persistent storage, so keep `replicas: 1`; the Recreate strategy prevents
overlapping replicas during normal Deployment updates and causes brief downtime.
Use a shared database such as PostgreSQL before scaling the service horizontally.

The Deployment references the published `bleosas/products-service` image on
Docker Hub by digest. Kubernetes pulls it from the registry. GitHub Actions
updates that digest after a successful build and vulnerability scan.

To deploy the current manifest manually on another cluster:

```powershell
kubectl apply -f k8s/00-namespace.yaml
kubectl apply -f k8s/
kubectl -n microservices rollout status deployment/products-service
kubectl -n microservices port-forward service/products-service 3000:80
```

The port-forward makes the API available at http://localhost:3000. These files
do not install Kubernetes or provision a cloud cluster. Deleting the PVC may
delete its stored data, depending on your storage class's reclaim policy.

## CI, GitOps, and observability

- `.github/workflows/ci-cd.yml` tests, builds, and scans the image on pull requests
  and relevant pushes to `main`. High and critical findings fail the job. On
  `main`, a second job publishes the tested image to Docker Hub and commits its
  digest to the deployment manifest. It uses the `USERNAME` and `DOCKER_TOKEN`
  GitHub repository secrets. See [CI_CD.md](CI_CD.md) for details.
- `security/.trivyignore` starts without exceptions. The optional SonarQube
  properties file needs your SonarQube URL/token; SonarQube is not installed or
  invoked by CI, and quality gates are managed on its server.
- `argocd/application.yaml` watches this GitHub repository's `main` branch and
  automatically synchronizes `k8s/` into the `microservices` namespace. Argo CD
  runs in the local cluster; GitHub does not need access to the cluster API.
- `monitoring/prometheus.yml` shows a scrape job for Prometheus running in the
  same namespace as the service. Mount it alongside `prometheus-rules.yaml`.
  For Prometheus in another namespace, use the service's full DNS name, such as
  `products-service.microservices.svc.cluster.local:80`. For Prometheus running
  natively on your host, set the target to `localhost:3000` while the API is running.
- Import `monitoring/grafana-dashboard.json` through Grafana's dashboard import
  screen and select your Prometheus data source. Prometheus, Grafana, and alert
  notification delivery are not installed by this project.

## Scope

This is a working learning service with persistent storage. It has no user
authentication or authorization; use it locally or on a trusted private network.
Public deployment requires access control and TLS. A production rollout also
needs database backups and environment-specific image, storage, and monitoring
configuration.

Reference documentation: [Node.js SQLite](https://nodejs.org/api/sqlite.html),
[GitHub checkout](https://github.com/actions/checkout),
[Node.js setup action](https://github.com/actions/setup-node), and
[Trivy action](https://github.com/aquasecurity/trivy-action).
