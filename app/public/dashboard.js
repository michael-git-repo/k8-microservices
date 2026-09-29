const $ = id => document.getElementById(id);
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const state = { items: [], total: 0, offset: 0, limit: 12, search: '', request: 0, editing: null, deleting: null, busy: false };
let searchTimer;
let toastTimer;

async function api(path, options) {
  const response = await fetch(path, options);
  if (response.status === 204) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function toast(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  $('total').textContent = state.total;
  $('count-label').textContent = state.search ? 'Matching products' : 'Total products';
  $('count-badge').textContent = state.total;
  $('average').textContent = state.items.length ? money.format(state.items.reduce((sum, item) => sum + item.priceCents / 100, 0) / state.items.length) : '—';
  $('refreshed').textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('empty').hidden = state.items.length > 0;
  $('empty-title').textContent = state.search ? 'No products found' : 'Your next great product starts here';
  $('empty-text').textContent = state.search ? 'Try a different name or description.' : 'Add your first product and give your collection a home.';
  $('empty-add').hidden = Boolean(state.search);
  $('products').replaceChildren(...state.items.map(item => {
    const card = element('article', 'product-card');
    const artwork = element('div', 'product-art', Array.from(item.name.trim()).slice(0, 2).join('').toUpperCase());
    artwork.setAttribute('aria-hidden', 'true');
    const details = element('div', 'product-details');
    const heading = element('h3', '', item.name);
    const description = element('p', 'product-description', item.description || 'No description yet.');
    const bottom = element('div', 'product-bottom');
    const actions = element('div', 'card-actions');
    const edit = element('button', 'button secondary', 'Edit');
    edit.setAttribute('aria-label', `Edit ${item.name}`);
    edit.addEventListener('click', () => openEditor(item));
    const remove = element('button', 'button secondary delete-button', 'Delete');
    remove.setAttribute('aria-label', `Delete ${item.name}`);
    remove.addEventListener('click', () => {
      state.deleting = item;
      $('delete-description').textContent = `Remove “${item.name}”?`;
      $('delete-error').hidden = true;
      $('delete-dialog').showModal();
      $('delete-dialog').querySelector('[data-close]').focus();
    });
    actions.append(edit, remove);
    bottom.append(element('span', 'product-price', money.format(item.priceCents / 100)), actions);
    details.append(heading, description, bottom);
    card.append(artwork, details);
    return card;
  }));
  $('page-summary').textContent = state.total ? `Showing ${state.offset + 1}–${Math.min(state.offset + state.limit, state.total)} of ${state.total} products` : '0 products in this collection';
  $('page-number').textContent = `Page ${Math.floor(state.offset / state.limit) + 1}`;
  $('previous').disabled = state.offset === 0;
  $('next').disabled = state.offset + state.limit >= state.total;
}

async function load() {
  const request = ++state.request;
  $('loading').hidden = false;
  $('products').hidden = true;
  $('empty').hidden = true;
  $('load-error').hidden = true;
  $('previous').disabled = true;
  $('next').disabled = true;
  $('refresh').disabled = true;
  try {
    const query = new URLSearchParams({ limit: state.limit, offset: state.offset, search: state.search });
    const data = await api(`/products?${query}`);
    if (request !== state.request) return;
    state.items = data.items;
    state.total = data.total;
    if (state.offset > 0 && state.offset >= state.total) {
      state.offset = Math.max(0, Math.floor((state.total - 1) / state.limit) * state.limit);
      return load();
    }
    $('connection').textContent = 'Connected';
    $('connection').className = 'connection online';
    render();
    $('products').hidden = false;
  } catch (error) {
    if (request !== state.request) return;
    $('load-error').textContent = `Could not load products. ${error.message} Use Refresh to try again.`;
    $('load-error').hidden = false;
    $('connection').textContent = 'Connection issue';
    $('connection').className = 'connection offline';
    $('total').textContent = '—';
    $('average').textContent = '—';
    $('page-summary').textContent = 'Products could not be loaded';
  } finally {
    if (request === state.request) {
      $('loading').hidden = true;
      $('refresh').disabled = false;
    }
  }
}

function openEditor(item = null) {
  state.editing = item;
  $('product-form').reset();
  $('form-error').hidden = true;
  $('editor-title').textContent = item ? 'Edit product' : 'Add product';
  $('name').value = item?.name ?? '';
  $('description').value = item?.description ?? '';
  // Keep the stored integer exact when presenting an existing price.
  $('price').value = item ? `${Math.floor(item.priceCents / 100)}.${String(item.priceCents % 100).padStart(2, '0')}` : '';
  $('editor').showModal();
  $('name').focus();
}

function busy(value) {
  state.busy = value;
  document.querySelectorAll('dialog button, dialog input, dialog textarea').forEach(node => { node.disabled = value; });
  $('save').textContent = value ? 'Saving…' : 'Save product';
  $('confirm-delete').textContent = value ? 'Deleting…' : 'Delete product';
}

$('product-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy) return;
  $('form-error').hidden = true;
  const [whole, fraction = ''] = $('price').value.trim().split('.');
  const priceCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(priceCents) || priceCents < 0) {
    $('form-error').textContent = 'Please enter a smaller valid price.';
    $('form-error').hidden = false;
    return;
  }
  const payload = { name: $('name').value.trim(), description: $('description').value, priceCents };
  busy(true);
  try {
    await api(state.editing ? `/products/${state.editing.id}` : '/products', {
      method: state.editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    $('editor').close();
    toast(state.editing ? 'Product updated.' : 'Product added to your collection.');
    if (!state.editing) {
      clearTimeout(searchTimer);
      state.search = '';
      $('search').value = '';
      const catalogue = await api('/products?limit=1');
      state.offset = Math.max(0, Math.floor((catalogue.total - 1) / state.limit) * state.limit);
    }
    await load();
  } catch (error) {
    if ($('editor').open) {
      $('form-error').textContent = error.message;
      $('form-error').hidden = false;
    } else {
      await load();
    }
  } finally { busy(false); }
});

$('delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.busy || !state.deleting) return;
  busy(true);
  try {
    await api(`/products/${state.deleting.id}`, { method: 'DELETE' });
    $('delete-dialog').close();
    toast('Product deleted.');
    await load();
  } catch (error) {
    $('delete-error').textContent = error.message;
    $('delete-error').hidden = false;
  } finally { busy(false); }
});

document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => {
  if (!state.busy) $(button.dataset.close).close();
}));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('cancel', event => { if (state.busy) event.preventDefault(); }));
$('add-product').addEventListener('click', () => openEditor());
$('empty-add').addEventListener('click', () => openEditor());
$('refresh').addEventListener('click', load);
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = $('search').value.trim(); state.offset = 0; load(); }, 250);
});
$('previous').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); load(); });
$('next').addEventListener('click', () => { state.offset += state.limit; load(); });
load();
