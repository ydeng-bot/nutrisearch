const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const rateLimit = require('express-rate-limit');
const app = express();

// Behind HAProxy and Nginx there are 2 proxies, so trust 2 hops
// to read the real visitor IP (needed for rate limiting).
app.set('trust proxy', 2);

if (!process.env.FDC_API_KEY) {
  console.log('Missing FDC_API_KEY. Add it to your .env file.');
}

const cache = new Map();       // search results, kept 10 minutes
const detailCache = new Map(); // food details, kept 10 minutes
const TEN_MIN = 10 * 60 * 1000;
const MAX_CACHE = 200;         // max entries per cache

// store a value; if the cache is full, remove the oldest entry first
function setCache(map, key, data) {
  if (map.size >= MAX_CACHE) {
    map.delete(map.keys().next().value);
  }
  map.set(key, { time: Date.now(), data });
}

// show which server answered (used to test the load balancer)
app.use((req, res, next) => {
  res.setHeader('X-Served-By', process.env.SERVER_NAME || 'local');
  next();
});

// limit each visitor to 60 API requests per minute so nobody
// can use up our 1,000 requests per hour at USDA
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests from you. Please wait a minute.' },
}));

app.use(express.static(path.join(__dirname, 'public')));

// helper: find a nutrient value inside a food (search results)
function nutrient(food, name) {
  const n = (food.foodNutrients || []).find((x) => x.nutrientName === name);
  return n ? n.value : 0;
}

// helper: calories = the Energy entry in KCAL (there is also one in kJ)
function calories(food) {
  const n = (food.foodNutrients || []).find(
    (x) => (x.nutrientName || '').startsWith('Energy') && x.unitName === 'KCAL'
  );
  return n ? n.value : 0;
}

// ---------- search foods ----------
app.get('/api/foods', async (req, res) => {
  const q = (req.query.q || '').trim().toLowerCase();

  if (!q || q.length > 50) {
    return res.status(400).json({ error: 'Please type a food name (max 50 characters).' });
  }

  const old = cache.get(q);
  if (old && Date.now() - old.time < TEN_MIN) {
    return res.json(old.data);
  }

  try {
    const url =
      'https://api.nal.usda.gov/fdc/v1/foods/search' +
      `?query=${encodeURIComponent(q)}` +
      '&dataType=Foundation,SR%20Legacy&pageSize=50' +
      `&api_key=${process.env.FDC_API_KEY}`;

    const response = await fetch(url);

    if (response.status === 429) {
      return res.status(429).json({ error: 'Too many requests. Try again in an hour.' });
    }
    if (!response.ok) throw new Error('API status ' + response.status);

    const json = await response.json();
    const foods = (json.foods || []).map((f) => ({
      id: f.fdcId,
      name: f.description,
      category: f.foodCategory || 'Other',
      calories: calories(f),
      protein: nutrient(f, 'Protein'),
      fat: nutrient(f, 'Total lipid (fat)'),
      carbs: nutrient(f, 'Carbohydrate, by difference'),
    }));

    setCache(cache, q, foods);
    res.json(foods);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'The food service is not responding. Try again later.' });
  }
});

// ---------- food details ----------
app.get('/api/food/:id', async (req, res) => {
  const id = req.params.id;

  // only numbers are allowed (input validation)
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: 'Invalid food ID.' });
  }

  const old = detailCache.get(id);
  if (old && Date.now() - old.time < TEN_MIN) {
    return res.json(old.data);
  }

  try {
    const url =
      `https://api.nal.usda.gov/fdc/v1/food/${id}` +
      `?api_key=${process.env.FDC_API_KEY}`;
    const response = await fetch(url);

    if (response.status === 404) {
      return res.status(404).json({ error: 'Food not found.' });
    }
    if (response.status === 429) {
      return res.status(429).json({ error: 'Too many requests. Try again in an hour.' });
    }
    if (!response.ok) throw new Error('API status ' + response.status);

    const f = await response.json();
    const nutrients = (f.foodNutrients || [])
      .filter((n) => n.amount !== undefined) // skips headings like "Minerals"
      .map((n) => ({
        name: n.nutrient.name,
        unit: n.nutrient.unitName,
        amount: Math.round(n.amount * 1000) / 1000,
      }));

    const data = { name: f.description, nutrients };
    setCache(detailCache, id, data);
    res.json(data);
  } catch (err) {
    console.error(err.message);
    res.status(502).json({ error: 'The food service is not responding. Try again later.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running on port ' + PORT));
