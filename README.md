# NutriSearch

A web app for students who want to know what is in their food. It searches the USDA FoodData Central database and lets you filter, sort and open the full nutrient list for a food. All values are per 100 g.

## Links
- Demo video: https://www.loom.com/share/ba9e9d01f6684fbf80b6f3cf0ab0e7bf
- Live site (load balancer): http://18.132.195.114
- Repo: https://github.com/ydeng-bot/nutrisearch

> The site uses plain HTTP, so the browser may show a "Not secure" warning. Click **Continue to site**.

## Features
- Search foods by name (top 50 matches)
- Filter by category and by high protein (10 g or more)
- Sort by name, calories (low to high or high to low) or protein
- Details panel with every nutrient for one food
- Clear error messages for: empty search, no results, API down, rate limit, bad food ID and no connection
- 10-minute cache for searches and food details, limited to 200 entries each
- Rate limit of 60 API requests per minute per visitor, so one user cannot use up the USDA quota
- All API data is escaped before it is shown (XSS protection)
- `X-Served-By` response header that shows which server answered (used to test the load balancer)

## API used
USDA FoodData Central, run by the U.S. Department of Agriculture.
- Docs: https://fdc.nal.usda.gov/api-guide.html
- Endpoints: `GET /fdc/v1/foods/search` (search) and `GET /fdc/v1/food/{fdcId}` (details)
- Access: free, but every request needs a data.gov API key. Get one at https://fdc.nal.usda.gov/api-key-signup.html. My server adds the key to each request.
- Rate limit: 1,000 requests per hour per IP address. Going over blocks the key for one hour (HTTP 429). I handle this with a clear error message, a cache and my own per-visitor limit.
- I did not use `DEMO_KEY` because it only allows 30 requests per hour.

## API security vetting
- Run by a US government agency (.gov domain), HTTPS only
- Official documentation and published rate limits
- Returns JSON only, no executable content
- The key stays in `.env` on the server. It never reaches the browser or the repo.
- Search input is validated (max 50 characters) and food IDs must be numbers
- API text is escaped (`& < > " '`) before display

## Project structure
```
nutrisearch/
├── server.js          # Express server: API proxy, cache, validation, rate limit
├── public/
│   ├── index.html     # Page layout
│   ├── style.css      # Styling
│   └── app.js         # Search, filter, sort, details panel
├── .env.example       # Template for settings (no real key)
├── .gitignore         # Keeps .env and node_modules out of Git
└── package.json
```

## Run locally
Requirements: Node.js 18 or higher (the code uses the built-in `fetch`).

```bash
git clone https://github.com/ydeng-bot/nutrisearch.git
cd nutrisearch
npm install
cp .env.example .env
```
Open `.env` and replace `put_your_key_here` with your USDA key. No quotes and no spaces around `=`. Then:
```bash
node server.js
```
Open **http://localhost:3000**. Do not open `index.html` with Live Server (port 5500): it has no `/api` routes, so searches fail.

## Deployment

```
User -> Lb01 (HAProxy :80) -> Web01 (Nginx :80 -> Node :3000)
                           -> Web02 (Nginx :80 -> Node :3000)
```

| Server | Address | Role |
|---|---|---|
| Web01 | 3.10.232.77 | App server (`SERVER_NAME=web01`) |
| Web02 | 3.10.170.254 | App server (`SERVER_NAME=web02`) |
| Lb01 | 18.132.195.114 | Load balancer |

### 1. Web01 and Web02 (repeat on both)
Log in with `ssh ubuntu@<server-ip>`, then:

```bash
sudo apt update
sudo apt install -y nginx git curl nano
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

git clone https://github.com/ydeng-bot/nutrisearch.git
cd nutrisearch
npm install
```

Create `.env` with the real key (never committed). Use `web01` on Web01 and `web02` on Web02:
```
FDC_API_KEY=your_real_key
PORT=3000
SERVER_NAME=web01
```

Start the app with pm2 so it restarts after a crash or reboot:
```bash
pm2 start server.js --name nutrisearch
pm2 save
pm2 startup
```
`pm2 startup` prints a command beginning with `sudo env PATH=...`. I ran that command, then `pm2 save` again.

Nginx reverse proxy, written to `/etc/nginx/sites-available/default`:
```nginx
server {
    listen 80 default_server;
    server_name _;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```
```bash
sudo nginx -t
sudo systemctl restart nginx
curl -I http://localhost     # should show X-Served-By: web01 (or web02)
```
`X-Forwarded-For` passes the visitor's real IP to the app, and `app.set('trust proxy', 2)` in `server.js` makes Express read it. That way the rate limiter counts each visitor separately.

To update later: `git pull`, `npm install`, then `pm2 restart nutrisearch`.

### 2. Load balancer (Lb01)
```bash
sudo apt update
sudo apt install -y haproxy
```
Lb01 already had an `http_front` frontend and an `http_back` backend from an earlier project, so adding a second frontend with the same name made HAProxy refuse the config. Instead of adding new blocks I edited the existing ones. The relevant part of `/etc/haproxy/haproxy.cfg` is now:

```
frontend http_front
    bind *:80
    bind *:443 ssl crt /etc/haproxy/certs/www.yomdeng.tech.pem
    mode http
    # redirect scheme https code 301 if !{ ssl_fc }
    default_backend http_back

backend http_back
    mode http
    balance roundrobin
    option forwardfor
    option httpchk GET /
    server 7265-web-01 3.10.232.77:80 check
    server 7265-web-02 3.10.170.254:80 check
```
- `balance roundrobin` sends requests to each server in turn.
- `option httpchk GET /` and `check` make HAProxy test each server and stop sending traffic to one that is down.
- `option forwardfor` adds the visitor's real IP to each request.
- I commented out the existing `redirect scheme https` line. The app only serves HTTP, so with the redirect active every request got a 301 instead of the app.

```bash
sudo haproxy -c -f /etc/haproxy/haproxy.cfg
sudo systemctl restart haproxy
```
The check prints a warning about the SSL DH parameter size. It comes from the old HTTPS setup and does not affect the app.

### 3. Testing the load balancer
Run from my laptop against the public address. Each server sets its own `X-Served-By` header, so the output shows who answered:
```bash
for i in 1 2 3 4 5 6; do curl -sI http://18.132.195.114 | grep -i x-served-by; done
```
Result: web01 and web02 take turns.

![Load balancer test](lb-test.png)

**Failover test:** I stopped the app on Web01 with `pm2 stop nutrisearch`. After a few seconds all six requests were answered by web02 and the site kept working. I then ran `pm2 start nutrisearch`, and web01 and web02 alternated again.

![Failover test](failover-test.png)

## Challenges and solutions
- **Keeping the API key secret:** calling USDA from the browser would expose the key, so my Express server makes the API calls and the key stays in `.env`. `.gitignore` keeps `.env` out of the repo. I checked with `git ls-files` before pushing.
- **Autocomplete changed my code:** VS Code autocomplete replaced `show();` with `SharedWorker();` and changed other words, which broke the search. I read the code line by line and fixed each one.
- **Overwrite mode:** the **OVR** indicator was on, so typing replaced existing characters and cut parts of my URLs. Pressing Insert turned it off.
- **API 403 error:** USDA rejected my requests because the URL lines in `server.js` used single quotes around `${...}`, so the literal text was sent instead of my key. Template strings (backticks) fixed it. The terminal log `API status 403` showed me where to look.
- **"Unexpected token <" error:** I had opened the page through Live Server on port 5500, which has no `/api` routes and returned HTML. Running `node server.js` and using port 3000 fixed it.
- **Filter row visible too early:** `display: flex` in my CSS overrode the `hidden` attribute. I added `[hidden] { display: none !important; }`.
- **Element id mismatch:** the checkbox id was `highprotein` in the HTML but `highProtein` in the JavaScript. Ids are case-sensitive, so the script crashed until I matched them.
- **Two energy values:** each food has Energy in both kJ and kcal, so the code picks the KCAL entry.
- **Duplicate HAProxy frontend:** Lb01 already had an `http_front` from an earlier project, and my new block clashed with it. I removed my duplicate and edited the existing frontend and backend instead. I also commented out the HTTPS redirect, which stopped the app from loading over HTTP.
- **Knowing which server answered:** I added an `X-Served-By` header so the load balancer test could show web01 and web02 alternating.
- **API rate limit:** the 10-minute cache (capped at 200 entries) and the per-visitor limit of 60 requests per minute protect the 1,000 requests per hour quota.
- **Missing nutrient values:** some USDA entries, such as the dry beans marked "(0% moisture)", don't report calories or total carbohydrate. They list starch and fibre separately, so the table shows 0 for those two columns. This means "not reported", not a real zero. The Details panel shows exactly what USDA provides for each food.

## Credits
- U.S. Department of Agriculture, Agricultural Research Service. FoodData Central, 2019. https://fdc.nal.usda.gov (public domain, CC0 1.0)
- Libraries and tools: [Express](https://expressjs.com), [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit), [dotenv](https://github.com/motdotla/dotenv), [Nginx](https://nginx.org), [HAProxy](https://www.haproxy.org), [PM2](https://pm2.keymetrics.io)
