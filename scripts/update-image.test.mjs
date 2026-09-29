import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateDeploymentImage } from './update-image.mjs';

const digest = 'a'.repeat(64);
const manifest = 'metadata:\n  namespace: microservices\nspec:\n  containers:\n    - name: products\n      image: bleosas/products-service:1.0.0\n      ports: [3000]\n';
test('updates only the image and normalizes the registry prefix', () => {
  assert.equal(updateDeploymentImage(manifest, `docker.io/bleosas/products-service@sha256:${digest}`),
    manifest.replace('bleosas/products-service:1.0.0', `bleosas/products-service@sha256:${digest}`));
});
test('rejects mutable tags, other repositories, and malformed digest values', () => {
  for (const invalid of ['bleosas/products-service:latest', `other/products-service@sha256:${digest}`, '',
    `bleosas/products-service@sha256:${digest}\nextra: value`, 'bleosas/products-service@sha256:abc']) {
    assert.throws(() => updateDeploymentImage(manifest, invalid), /digest-pinned/);
  }
});
test('refuses missing, ambiguous, or unrelated images', () => {
  for (const invalid of ['metadata: {}', manifest + 'image: another\n', manifest.replace('bleosas/products-service:1.0.0', 'another:latest')]) {
    assert.throws(() => updateDeploymentImage(invalid, `bleosas/products-service@sha256:${digest}`));
  }
});
