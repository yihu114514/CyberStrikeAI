/**
 * 系统设置 - 终端：多标签、流式输出、命令历史、Ctrl+L 清屏、长时间可取消
 */
(function () {
    var getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
        if (type === '2d') {
            attrs = (attrs && typeof attrs === 'object') ? Object.assign({ willReadFrequently: true }, attrs) : { willReadFrequently: true };
            return getContext.call(this, type, attrs);
        }
        return getContext.apply(this, arguments);
    };

    var terminals = [];
    var currentTabId = 1;
    var inited = false;
    var tabIdCounter = 1;
    var PROMPT = '\x1b[32m$\x1b[0m ';
    var HISTORY_MAX = 100;
    var CANCEL_AFTER_MS = 125000;

    function getCurrent() {
        for (var i = 0; i < terminals.length; i++) {
            if (terminals[i].id === currentTabId) return terminals[i];
        }
        return terminals[0] || null;
    }

    var WELCOME_LINE = 'CyberStrikeAI 终端 - 直接输入命令，Enter 执行；↑↓ 历史；Ctrl+L 清屏\r\n';

    function writePrompt(tab) {
        var t = tab || getCurrent();
        if (t && t.term) t.term.write(PROMPT);
    }

    function redrawTabDisplay(t) {
        if (!t || !t.term) return;
        t.term.clear();
        t.lineBuffer = '';
        if (t.cursorIndex !== undefined) t.cursorIndex = 0;
        t.term.write(WELCOME_LINE);
        t.term.write(PROMPT);
    }

    function writeln(tabOrS, s) {
        var t, text;
        if (arguments.length === 1) { text = tabOrS; t = getCurrent(); } else { t = tabOrS; text = s; }
        if (!t || !t.term) return;
        if (text) t.term.writeln(text);
        else t.term.writeln('');
    }

    function writeOutput(tab, text, isError) {
        var t = tab || getCurrent();
        if (!t || !t.term || !text) return;
        var s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = s.split('\n');
        var prefix = isError ? '\x1b[31m' : '';
        var suffix = isError ? '\x1b[0m' : '';
        t.term.write(prefix);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/\r/g, '');
            t.term.writeln(line);
        }
        t.term.write(suffix);
    }

    function getAuthHeaders() {
        var h = new Headers();
        h.set('Content-Type', 'application/json');
        try {
            var auth = localStorage.getItem('cyberstrike-auth');
            if (auth) {
                var o = JSON.parse(auth);
                if (o && o.token) h.set('Authorization', 'Bearer ' + o.token);
            }
        } catch (e) {}
        return h;
    }

    function runCommand(cmd, tab) {
        var t = tab || getCurrent();
        if (!t) return;
        if (t.running) return;
        runCommandImpl(cmd, t);
    }

    function runCommandImpl(cmd, t) {
        t.running = true;
        t.abortController = new AbortController();
        var cancelTimer = setTimeout(function () {
            if (!t.running) return;
            t.running = false;
            writeln(t, '\x1b[2m(已取消 可继续输入)\x1b[0m');
            writePrompt(t);
        }, CANCEL_AFTER_MS);

        var done = function () {
            clearTimeout(cancelTimer);
            t.running = false;
            t.abortController = null;
            writePrompt(t);
        };

        fetch('/api/terminal/run/stream', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ command: cmd }),
            signal: t.abortController.signal
        }).then(function (res) {
            if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || 'HTTP ' + res.status); });
            var ct = res.headers.get('Content-Type') || '';
            if (ct.indexOf('text/event-stream') !== -1 && res.body) {
                return readSSEStream(res.body, t).then(done).catch(function () { done(); });
            }
            return res.json().then(function (data) {
                if (data.stdout) writeOutput(t, data.stdout, false);
                if (data.stderr) writeOutput(t, data.stderr, true);
                done();
            });
        }).catch(function (err) {
            if (err.name === 'AbortError') {
                writeln(t, '\x1b[2m(已取消)\x1b[0m');
            } else {
                writeln(t, '\x1b[31m错误: ' + (err.message || String(err)) + '\x1b[0m');
            }
            done();
        });
    }

    function readSSEStream(body, t) {
        return new Promise(function (resolve, reject) {
            var reader = body.getReader();
            var decoder = new TextDecoder();
            var buf = '';
            function read() {
                reader.read().then(function (result) {
                    if (result.done) { resolve(); return; }
                    buf += decoder.decode(result.value, { stream: true });
                    var i;
                    while ((i = buf.indexOf('\n\n')) !== -1) {
                        var block = buf.slice(0, i);
                        buf = buf.slice(i + 2);
                        var dataLine = block.match(/data:\s*(.+)/);
                        if (dataLine) {
                            try {
                                var ev = JSON.parse(dataLine[1]);
                                if (ev.t === 'out' && ev.d !== undefined) t.term.writeln(ev.d);
                                else if (ev.t === 'err' && ev.d !== undefined) t.term.write('\x1b[31m' + ev.d + '\x1b[0m\n');
                                else if (ev.t === 'exit') {
                                    resolve();
                                    return;
                                }
                            } catch (e) {}
                        }
                    }
                    read();
                }).catch(reject);
            }
            read();
        });
    }

    function createTerminalInContainer(container, tab) {
        if (typeof Terminal === 'undefined') return null;
        if (!tab.history) tab.history = [];
        if (tab.historyIndex === undefined) tab.historyIndex = -1;
        if (tab.cursorIndex === undefined) tab.cursorIndex = 0;

        var term = new Terminal({
            cursorBlink: true,
            cursorStyle: 'bar',
            fontSize: 13,
            fontFamily: 'Menlo, Monaco, "Courier New", monospace',
            lineHeight: 1.2,
            scrollback: 1000,
            theme: {
                background: '#0d1117',
                foreground: '#e6edf3',
                cursor: '#58a6ff',
                cursorAccent: '#0d1117',
                selection: 'rgba(88, 166, 255, 0.3)',
                black: '#484f58',
                red: '#ff7b72',
                green: '#3fb950',
                yellow: '#d29922',
                blue: '#58a6ff',
                magenta: '#bc8cff',
                cyan: '#39c5cf',
                white: '#e6edf3',
                brightBlack: '#6e7681',
                brightRed: '#ffa198',
                brightGreen: '#56d364',
                brightYellow: '#e3b341',
                brightBlue: '#79c0ff',
                brightMagenta: '#d2a8ff',
                brightCyan: '#56d4dd',
                brightWhite: '#f0f6fc'
            }
        });
        var fitAddon = null;
        if (typeof FitAddon !== 'undefined') {
            var FitCtor = (FitAddon.FitAddon || FitAddon);
            fitAddon = new FitCtor();
            term.loadAddon(fitAddon);
        }
        term.open(container);
        term.write(WELCOME_LINE);
        term.write(PROMPT);
        container.addEventListener('click', function () {
            switchTerminalTab(tab.id);
            if (term) term.focus();
        });
        container.setAttribute('tabindex', '0');
        container.title = '点击此处后输入命令';

        function redrawLine(t) {
            if (!t || !t.term) return;
            var n = t.lineBuffer.length - t.cursorIndex;
            t.term.write('\r\x1b[K' + PROMPT + t.lineBuffer);
            if (n > 0) t.term.write('\x1b[' + n + 'D');
        }

        term.onData(function (data) {
            if (data === '\x0c') {
                term.clear();
                tab.lineBuffer = '';
                tab.cursorIndex = 0;
                writePrompt(tab);
                return;
            }
            if (data === '\x1b[A') {
                if (tab.history.length === 0) return;
                if (tab.historyIndex < 0) tab.historyIndex = tab.history.length;
                tab.historyIndex--;
                if (tab.historyIndex < 0) tab.historyIndex = 0;
                tab.lineBuffer = tab.history[tab.historyIndex];
                tab.cursorIndex = tab.lineBuffer.length;
                term.write('\r\x1b[K' + PROMPT + tab.lineBuffer);
                return;
            }
            if (data === '\x1b[B') {
                if (tab.history.length === 0) return;
                tab.historyIndex++;
                if (tab.historyIndex >= tab.history.length) {
                    tab.historyIndex = -1;
                    tab.lineBuffer = '';
                    tab.cursorIndex = 0;
                    term.write('\r\x1b[K' + PROMPT);
                } else {
                    tab.lineBuffer = tab.history[tab.historyIndex];
                    tab.cursorIndex = tab.lineBuffer.length;
                    term.write('\r\x1b[K' + PROMPT + tab.lineBuffer);
                }
                return;
            }
            if (data === '\x1b[D') {
                if (tab.cursorIndex > 0) {
                    tab.cursorIndex--;
                    term.write('\x1b[D');
                }
                return;
            }
            if (data === '\x1b[C') {
                if (tab.cursorIndex < tab.lineBuffer.length) {
                    tab.cursorIndex++;
                    term.write('\x1b[C');
                }
                return;
            }
            var code = data.charCodeAt(0);
            if (code === 13 || code === 10) {
                var cmd = tab.lineBuffer.trim();
                tab.lineBuffer = '';
                tab.cursorIndex = 0;
                tab.historyIndex = -1;
                term.writeln('');
                if (cmd) {
                    if (tab.history.indexOf(cmd) === -1) {
                        tab.history.push(cmd);
                        if (tab.history.length > HISTORY_MAX) tab.history.shift();
                    }
                    runCommand(cmd, tab);
                } else {
                    writePrompt(tab);
                }
                return;
            }
            if (code === 127) {
                if (tab.cursorIndex > 0) {
                    tab.lineBuffer = tab.lineBuffer.slice(0, tab.cursorIndex - 1) + tab.lineBuffer.slice(tab.cursorIndex);
                    tab.cursorIndex--;
                    redrawLine(tab);
                }
                return;
            }
            if (code === 3) {
                if (tab.running && tab.abortController) {
                    tab.abortController.abort();
                }
                tab.lineBuffer = '';
                tab.cursorIndex = 0;
                term.writeln('^C');
                writePrompt(tab);
                return;
            }
            if (data.length === 1 && code >= 32) {
                tab.lineBuffer = tab.lineBuffer.slice(0, tab.cursorIndex) + data + tab.lineBuffer.slice(tab.cursorIndex);
                tab.cursorIndex++;
                redrawLine(tab);
                return;
            }
            tab.lineBuffer += data;
            tab.cursorIndex = tab.lineBuffer.length;
            term.write(data);
        });

        tab.term = term;
        tab.fitAddon = fitAddon;
        return term;
    }

    function switchTerminalTab(id) {
        var prevId = currentTabId;
        currentTabId = id;
        document.querySelectorAll('.terminal-tab').forEach(function (el) {
            el.classList.toggle('active', parseInt(el.getAttribute('data-tab-id'), 10) === id);
        });
        document.querySelectorAll('.terminal-pane').forEach(function (el) {
            var paneId = el.getAttribute('id');
            var match = paneId && paneId.match(/terminal-pane-(\d+)/);
            var paneTabId = match ? parseInt(match[1], 10) : 0;
            el.classList.toggle('active', paneTabId === id);
        });
        var t = getCurrent();
        if (t && t.term) {
            if (prevId !== id) {
                requestAnimationFrame(function () {
                    if (currentTabId === id && t.term) t.term.focus();
                });
            } else {
                t.term.focus();
            }
        }
    }

    function addTerminalTab() {
        if (typeof Terminal === 'undefined') return;
        tabIdCounter += 1;
        var id = tabIdCounter;
        var paneId = 'terminal-pane-' + id;
        var containerId = 'terminal-container-' + id;
        var tabsEl = document.querySelector('.terminal-tabs');
        var panesEl = document.querySelector('.terminal-panes');
        if (!tabsEl || !panesEl) return;

        var tabDiv = document.createElement('div');
        tabDiv.className = 'terminal-tab';
        tabDiv.setAttribute('data-tab-id', String(id));
        var label = document.createElement('span');
        label.className = 'terminal-tab-label';
        label.textContent = '终端 ' + id;
        label.onclick = function () { switchTerminalTab(id); };
        var closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'terminal-tab-close';
        closeBtn.title = '关闭';
        closeBtn.textContent = '×';
        closeBtn.onclick = function (e) { e.stopPropagation(); removeTerminalTab(id); };
        tabDiv.appendChild(label);
        tabDiv.appendChild(closeBtn);
        var plusBtn = tabsEl.querySelector('.terminal-tab-new');
        tabsEl.insertBefore(tabDiv, plusBtn);

        var paneDiv = document.createElement('div');
        paneDiv.id = paneId;
        paneDiv.className = 'terminal-pane';
        var containerDiv = document.createElement('div');
        containerDiv.id = containerId;
        containerDiv.className = 'terminal-container';
        paneDiv.appendChild(containerDiv);
        panesEl.appendChild(paneDiv);

        var tab = { id: id, paneId: paneId, containerId: containerId, lineBuffer: '', cursorIndex: 0, running: false, term: null, fitAddon: null, history: [], historyIndex: -1 };
        terminals.push(tab);
        createTerminalInContainer(containerDiv, tab);
        switchTerminalTab(id);
        updateTerminalTabCloseVisibility();
        setTimeout(function () {
            try { if (tab.fitAddon) tab.fitAddon.fit(); if (tab.term) tab.term.focus(); } catch (e) {}
        }, 50);
    }

    function updateTerminalTabCloseVisibility() {
        var tabsEl = document.querySelector('.terminal-tabs');
        if (!tabsEl) return;
        var tabDivs = tabsEl.querySelectorAll('.terminal-tab');
        var showClose = terminals.length > 1;
        for (var i = 0; i < tabDivs.length; i++) {
            var btn = tabDivs[i].querySelector('.terminal-tab-close');
            if (btn) btn.style.display = showClose ? '' : 'none';
        }
    }

    function removeTerminalTab(id) {
        if (terminals.length <= 1) return;
        var idx = -1;
        for (var i = 0; i < terminals.length; i++) { if (terminals[i].id === id) { idx = i; break; } }
        if (idx < 0) return;

        var deletingCurrent = (currentTabId === id);
        var switchToIndex = deletingCurrent ? (idx > 0 ? idx - 1 : 0) : -1;

        var tab = terminals[idx];
        if (tab.term && tab.term.dispose) tab.term.dispose();
        tab.term = null;
        tab.fitAddon = null;
        terminals.splice(idx, 1);

        var tabDiv = document.querySelector('.terminal-tab[data-tab-id="' + id + '"]');
        var paneDiv = document.getElementById('terminal-pane-' + id);
        if (tabDiv && tabDiv.parentNode) tabDiv.parentNode.removeChild(tabDiv);
        if (paneDiv && paneDiv.parentNode) paneDiv.parentNode.removeChild(paneDiv);

        var curIdxBeforeRenumber = -1;
        if (!deletingCurrent) {
            for (var i = 0; i < terminals.length; i++) {
                if (terminals[i].id === currentTabId) { curIdxBeforeRenumber = i; break; }
            }
        }

        for (var i = 0; i < terminals.length; i++) {
            var t = terminals[i];
            t.id = i + 1;
            t.paneId = 'terminal-pane-' + (i + 1);
            t.containerId = 'terminal-container-' + (i + 1);
        }
        tabIdCounter = terminals.length;
        if (curIdxBeforeRenumber >= 0) currentTabId = terminals[curIdxBeforeRenumber].id;

        var tabsEl = document.querySelector('.terminal-tabs');
        var panesEl = document.querySelector('.terminal-panes');
        if (tabsEl) {
            var tabDivs = tabsEl.querySelectorAll('.terminal-tab');
            for (var i = 0; i < tabDivs.length; i++) {
                var t = terminals[i];
                tabDivs[i].setAttribute('data-tab-id', String(t.id));
                var lbl = tabDivs[i].querySelector('.terminal-tab-label');
                if (lbl) lbl.textContent = '终端 ' + t.id;
                if (lbl) lbl.onclick = (function (tid) { return function () { switchTerminalTab(tid); }; })(t.id);
                var cb = tabDivs[i].querySelector('.terminal-tab-close');
                if (cb) cb.onclick = (function (tid) { return function (e) { e.stopPropagation(); removeTerminalTab(tid); }; })(t.id);
            }
        }
        if (panesEl) {
            var paneDivs = panesEl.querySelectorAll('.terminal-pane');
            for (var i = 0; i < paneDivs.length; i++) {
                var t = terminals[i];
                paneDivs[i].id = t.paneId;
                var cont = paneDivs[i].querySelector('.terminal-container');
                if (cont) cont.id = t.containerId;
            }
        }

        updateTerminalTabCloseVisibility();

        if (deletingCurrent && terminals.length > 0) {
            currentTabId = terminals[switchToIndex].id;
            switchTerminalTab(currentTabId);
        }
    }

    function initTerminal() {
        var pane1 = document.getElementById('terminal-pane-1');
        var container1 = document.getElementById('terminal-container-1');
        if (!pane1 || !container1) return;
        if (inited) {
            var t = getCurrent();
            if (t && t.term) t.term.focus();
            terminals.forEach(function (tab) { try { if (tab.fitAddon) tab.fitAddon.fit(); } catch (e) {} });
            return;
        }
        inited = true;

        if (typeof Terminal === 'undefined') {
            container1.innerHTML = '<p class="terminal-error">未加载 xterm.js，请刷新页面或检查网络。</p>';
            return;
        }

        currentTabId = 1;
        var tab = { id: 1, paneId: 'terminal-pane-1', containerId: 'terminal-container-1', lineBuffer: '', cursorIndex: 0, running: false, term: null, fitAddon: null, history: [], historyIndex: -1 };
        terminals.push(tab);
        createTerminalInContainer(container1, tab);

        updateTerminalTabCloseVisibility();

        setTimeout(function () {
            try { if (tab.fitAddon) tab.fitAddon.fit(); if (tab.term) tab.term.focus(); } catch (e) {}
        }, 100);

        var resizeTimer;
        window.addEventListener('resize', function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                terminals.forEach(function (t) { try { if (t.fitAddon) t.fitAddon.fit(); } catch (e) {} });
            }, 150);
        });
    }

    function terminalClear() {
        var t = getCurrent();
        if (!t || !t.term) return;
        t.term.clear();
        t.lineBuffer = '';
        if (t.cursorIndex !== undefined) t.cursorIndex = 0;
        writePrompt(t);
        t.term.focus();
    }

    window.initTerminal = initTerminal;
    window.terminalClear = terminalClear;
    window.switchTerminalTab = switchTerminalTab;
    window.addTerminalTab = addTerminalTab;
    window.removeTerminalTab = removeTerminalTab;
})();
