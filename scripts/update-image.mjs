import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function updateDeploymentImage(manifest, reference) {
  if (!/^(?:docker\.io\/)?bleosas\/products-service@sha256:[a-f0-9]{64}$/.test(reference)) {
    throw new Error('Expected a digest-pinned bleosas/products-service image');
  }
  const imageLines = [...manifest.matchAll(/^(\s*image:\s*)[^\r\n]+/gm)];
  if (imageLines.length !== 1) throw new Error('Expected exactly one container image in the deployment');
  const currentImage = imageLines[0][0].trim().slice('image:'.length).trim();
  if (!/^(?:docker\.io\/)?bleosas\/products-service(?=[:@])/.test(currentImage)) {
    throw new Error('Refusing to change an unrelated container image');
  }
  const normalized = reference.replace(/^docker\.io\//, '');
  return manifest.replace(/^(\s*image:\s*)[^\r\n]+/m, (_, prefix) => prefix + normalized);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const filename = resolve('k8s/deployment.yaml');
  const updated = updateDeploymentImage(readFileSync(filename, 'utf8'), process.argv[2] ?? '');
  writeFileSync(filename, updated);
  console.log('Updated k8s/deployment.yaml to the published image digest.');
}
