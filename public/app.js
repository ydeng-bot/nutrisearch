let foods = []; // all results from the last search

const form = document.getElementById('searchForm');
const message = document.getElementById('message');
const table = document.getElementById('table');
const controls = document.getElementById('controls');
const details = document.getElementById('details');

// make text safe so nobody can inject HTML (XSS protection)
// escapes & < > " ' so it is also safe inside value="..." attributes
function safe(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = document.getElementById('query').value.trim();
  message.className = '';
  message.textContent = 'Loading...';
  table.hidden = true;
  controls.hidden = true;
  details.hidden = true;

  try {
    const res = await fetch('/api/foods?q=' + encodeURIComponent(q));
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || 'Something went wrong.');
    if (data.length === 0) {
      message.textContent = 'No foods found for "' + q + '". Try another word.';
      return;
    }

    foods = data;
    fillCategories();
    controls.hidden = false;
    show();
  } catch (err) {
    message.className = 'error';
    message.textContent = err.message === 'Failed to fetch'
      ? 'Cannot reach the server. Check your internet.'
      : err.message;
  }
});

// fill the category dropdown from the results
function fillCategories() {
  const cats = [...new Set(foods.map((f) => f.category))].sort();
  const select = document.getElementById('category');
  select.innerHTML = '<option value="all">All categories</option>' +
    cats.map((c) => `<option value="${safe(c)}">${safe(c)}</option>`).join('');
}

// filter + sort + draw the table
function show() {
  const cat = document.getElementById('category').value;
  const sort = document.getElementById('sort').value;
  const high = document.getElementById('highProtein').checked;

  let list = foods.filter((f) => (cat === 'all' || f.category === cat) && (!high || f.protein >= 10));

  if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'calLow') list.sort((a, b) => a.calories - b.calories);
  if (sort === 'calHigh') list.sort((a, b) => b.calories - a.calories);
  if (sort === 'protein') list.sort((a, b) => b.protein - a.protein);

  if (list.length === 0) {
    table.hidden = true;
    message.textContent = 'No foods match your filters.';
    return;
  }

  message.textContent = list.length + ' foods shown';
  table.hidden = false;
  document.getElementById('results').innerHTML = list.map((f) => `
    <tr>
      <td>${safe(f.name)}<br><button class="small" data-id="${safe(f.id)}">Details</button></td>
      <td>${f.calories}</td>
      <td>${f.protein}<div class="bar" style="width:${Math.min(f.protein, 40) * 2.5}%"></div></td>
      <td>${f.fat}</td>
      <td>${f.carbs}</td>
    </tr>`).join('');
}

// re-draw when any control changes
['category', 'sort', 'highProtein'].forEach((id) =>
  document.getElementById(id).addEventListener('change', show));

// click a Details button -> load all nutrients of that food
document.getElementById('results').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-id]');
  if (!btn) return;

  details.hidden = false;
  details.innerHTML = 'Loading details...';
  details.scrollIntoView({ behavior: 'smooth' });

  try {
    const res = await fetch('/api/food/' + btn.dataset.id);
    const food = await res.json();
    if (!res.ok) throw new Error(food.error || 'Something went wrong.');

    const rows = food.nutrients.map((n) => `
      <tr>
        <td>${safe(n.name)}</td>
        <td>${safe(n.amount)} ${safe(String(n.unit).toLowerCase())}</td>
      </tr>`).join('');

    details.innerHTML = `
      <h2>${safe(food.name)}</h2>
      <button class="small" id="closeDetails">Close</button>
      <table><tr><th>Nutrient</th><th>Amount (per 100 g)</th></tr>${rows}</table>`;

    document.getElementById('closeDetails').addEventListener('click', () => {
      details.hidden = true;
    });
  } catch (err) {
    details.innerHTML = '<p class="error">' + safe(err.message) + '</p>';
  }
});
