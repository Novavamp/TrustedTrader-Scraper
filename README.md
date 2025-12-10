# TrustedTrader.scot Scraper

A high-performance Node.js scraper that extracts businesses from **TrustedTrader.scot**, organizes them by category and region, and outputs a fully structured **ListingPro-ready CSV**.
Includes a polished real-time frontend with live progress, logs, category tracking, and CSV download.

---

## 🚀 Features

### ✅ **Full Site Scraping**

* Scrape a **single region** (e.g., “Edinburgh”, “Dundee”, “Aberdeenshire”)
* Or **leave region blank** → automatically scrape *all available regions*

### ⚙️ **Smart Architecture**

* Server streams progress via **Server-Sent Events (SSE)**
* Frontend updates live with:

  * Current category
  * Current trader
  * Total scraped count
  * Overall progress bar
  * Real-time logs

### 📄 **CSV Output**

* Generates ListingPro-compatible CSV
* Auto-saves after each category
* Downloadable immediately after job completion

### 🧼 **Frontend UI**

* Modern glassmorphic UI
* Mobile-responsive
* Log-safe rendering (handles long strings without breaking layout)

---

## 📂 Project Structure

```
/project-root
│── server.js              # Server (Node.js, Express, SSE)
│── scraper.js            # The TrustedTrader scraper logic
│── public/
│     ├── index.html      # Frontend UI
│     ├── style.css       # Polished UI styles
│     └── index.js        # Frontend logic & SSE listener
│── downloads/            # Output CSV files
│── package.json
│── README.md
```

---

## 🛠️ Tech Stack

### **Backend**

* Node.js (ES modules)
* Express.js
* Axios
* Cheerio
* Server-Sent Events (SSE)
* FS streams for fast CSV writing

### **Frontend**

* Vanilla JavaScript
* Styled UI (glassmorphism)
* Live progress tracking
* Log streaming

---

## 📦 Installation

Clone the repo:

```bash
git clone https://github.com/Novavamp/TrustedTrader-Scraper.git
cd TrustedTrader-Scraper
```

Install dependencies:

```bash
npm install
```

Start the server:

```bash
node index.js
```

Open in browser:

```
http://localhost:3000
```

---

## 🧩 Usage

### ▶️ Start a Scrape

Go to the frontend and enter:

* **Region (optional)**
  Leave empty to scrape **all regions**

* **Limit (optional)**
  `0` = unlimited
  Any number = stop after total traders reach limit

Click **Start Scrape**.

### 📡 Real-Time Updates

You’ll see:

* Overall progress bar
* Current region
* Current category
* Current trader name
* Live log feed
* Total count

### 📥 Download CSV

When scraping finishes:

* A **Download CSV** button appears
* File is saved inside `downloads/` on server as:

```
trustedtrader_<region>_<timestamp>.csv
```

For example:

```
trustedtrader_Edinburgh_1765371054630.csv
```

Or if region was blank:

```
trustedtrader_ALL_REGIONS_1765371054630.csv
```

---

## 🗂 CSV Output Format

Each row includes:

```
title
email
phone
category
address
website
city
county
postcode
description
reviews
rating
latitude
longitude
```

(Depending on available fields — scraper fills blank if missing.)

---

## 🧪 Development Notes

* The scraper uses polite delays to avoid hammering TrustedTrader.
* Real-time SSE ensures the UI never freezes.
* Long URLs/logs auto-wrap to prevent mobile-layout overflow.
* The scraper stops early if the limit is reached.

---

## 🤝 Contributing

Pull requests are welcome!
If submitting:

1. Prettify code (`npm run format` if available)
2. Follow ES module import style
3. Keep UI minimal + performant

---

## ⚠️ Legal Notice

This tool is for **educational and personal use**.
Before scraping any website, ensure you comply with their **Terms of Service** and local laws.

---

## ⭐ Support

If you found this useful, star ⭐ the repo — it helps visibility.