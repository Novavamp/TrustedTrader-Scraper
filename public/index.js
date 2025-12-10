// Frontend logic: communicate with server using fetch + EventSource
(function () {
    const form = document.getElementById('scrapeForm');
    const startBtn = document.getElementById('startBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const logsEl = document.getElementById('logs');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const jobInfo = document.getElementById('jobInfo');
    const scrapedCount = document.getElementById('scrapedCount');
    const progressInner = document.getElementById('progressInner');
    const currentCategory = document.getElementById('currentCategory');
    const currentTrader = document.getElementById('currentTrader');
    const downloadLink = document.getElementById('downloadLink');
    const finishedNote = document.getElementById('finishedNote');
    const elapsed = document.getElementById('elapsed');

    let evtSource = null;
    let jobId = null;
    let startTime = null;
    let timerInterval = null;

    function appendLog(txt) {
        const div = document.createElement('div');
        div.className = 'line';
        div.textContent = txt;
        logsEl.prepend(div);
    }

    function setStatus(s) {
        statusText.textContent = s;
        if (s.toLowerCase().includes('running')) { statusDot.className = 'status-dot st-running' }
        else if (s.toLowerCase().includes('error')) { statusDot.className = 'status-dot st-error' }
        else if (s.toLowerCase().includes('done')) { statusDot.className = 'status-dot st-done' }
        else statusDot.className = 'status-dot st-idle'
    }

    function startTimer() {
        startTime = Date.now();
        timerInterval = setInterval(() => {
            const s = Math.floor((Date.now() - startTime) / 1000);
            const mm = String(Math.floor(s / 60)).padStart(2, '0');
            const ss = String(s % 60).padStart(2, '0');
            elapsed.textContent = mm + ':' + ss;
        }, 500);
    }
    function stopTimer() { clearInterval(timerInterval); timerInterval = null; elapsed.textContent = '00:00' }

    document.getElementById('clearLogs').addEventListener('click', () => { logsEl.innerHTML = ''; });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        startBtn.disabled = true; cancelBtn.disabled = false;
        downloadLink.style.display = 'none'; finishedNote.textContent = 'Starting...';
        logsEl.innerHTML = '';

        const region = document.getElementById('region').value.trim();
        const limit = Number(document.getElementById('limit').value) || 0;
        const regionDisplay = region && region.trim() ? region.trim() : "All Region";

        try {
            setStatus('Starting job...');
            appendLog(`Requesting server to start scrape for: ${region} (limit: ${limit})`);
            const res = await fetch('/api/scrape', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region, limit })
            });
            if (!res.ok) throw new Error('Server responded ' + res.status);
            const data = await res.json();
            jobId = data.jobId;
            jobInfo.textContent = `Job ${jobId} — region: ${regionDisplay}`;
            setStatus('Running');
            startTimer();

            // open SSE
            evtSource && evtSource.close();
            evtSource = new EventSource(`/api/scrape/events?jobId=${encodeURIComponent(jobId)}`);

            evtSource.onmessage = (ev) => {
                // Generic message w/ JSON
                try {
                    const payload = JSON.parse(ev.data);
                    handleEvent(payload);
                } catch (err) {
                    appendLog('[sse] ' + ev.data);
                }
            };

            evtSource.onerror = (err) => {
                appendLog('[sse] connection closed or error');
                // don't kill UI here; server will also send final state
            };

        } catch (err) {
            appendLog('Start error: ' + err.message);
            setStatus('Error');
            startBtn.disabled = false; cancelBtn.disabled = true;
            finishedNote.textContent = 'Error starting job';
        }
    });

    cancelBtn.addEventListener('click', async () => {
        if (!jobId) return;
        appendLog('Requesting cancel for job ' + jobId);
        try {
            const r = await fetch('/api/scrape/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId }) });
            const j = await r.json();
            appendLog('Server: ' + (j.message || 'cancel requested'));
        } catch (err) { appendLog('Cancel error: ' + err.message) }
    });

    function handleEvent(ev) {
        // expected event shape: { type: 'progress'|'log'|'category'|'trader'|'finished'|'error', data: { ... } }
        if (ev.type === 'log') {
            appendLog(ev.data.text || JSON.stringify(ev.data));
        } else if (ev.type === 'progress') {
            const { scraped = 0, total = 0 } = ev.data;
            scrapedCount.textContent = `Scraped: ${scraped}`;
            let pct = 0;
            if (total > 0) pct = Math.min(100, Math.round((scraped / total) * 100));
            progressInner.style.width = pct + '%';
        } else if (ev.type === 'category') {
            currentCategory.textContent = ev.data.name || '—';
        } else if (ev.type === 'trader') {
            currentTrader.textContent = ev.data.url || ev.data.name || '—';
        } else if (ev.type === 'finished') {
            appendLog('Job finished. File: ' + (ev.data.file || 'unknown'));
            setStatus('Done');
            startBtn.disabled = false; cancelBtn.disabled = true;
            stopTimer();
            if (ev.data.file) {
                downloadLink.href = ev.data.file;
                downloadLink.style.display = 'inline-flex';
                finishedNote.textContent = 'Ready to download';
                downloadLink.textContent = 'Download CSV';
                // open in new tab automatically? optional
            }
            // close SSE
            evtSource && evtSource.close(); evtSource = null; jobId = null;
        } else if (ev.type === 'error') {
            appendLog('Error: ' + (ev.data.message || JSON.stringify(ev.data)));
            setStatus('Error');
            startBtn.disabled = false; cancelBtn.disabled = true;
            stopTimer();
        } else if (ev.type === 'progress') {
            const { scraped = 0, total = 0 } = ev.data;
            scrapedCount.textContent = `Scraped: ${scraped}`;

            if (total > 0) {
                // determinate
                progressInner.classList.remove('indeterminate');
                const pct = Math.min(100, Math.round((scraped / total) * 100));
                progressInner.style.width = pct + '%';
            } else {
                // indeterminate (unknown / unlimited)
                progressInner.classList.add('indeterminate');
                // keep width full so animation is visible
                progressInner.style.width = '100%';
            }
        }
    }
})();