/**
 * Local-P2P-Share - WebRTC DataChannel 高速ファイル転送 コアスクリプト
 * 同一Wi-Fi環境下で iPhone / iPad / Android / PC 間の相互大容量データ高速転送
 * iOS Safari のスリープ・シグナリング再接続・生バイナリ転送に完全対応
 */

(function () {
    'use strict';

    // =========================================================================
    // ⚙️ 設定定数
    // =========================================================================
    const CONFIG = {
        CHUNK_SIZE: 64 * 1024,            // 64KB バイナリチャンク（WebRTC最適サイズ）
        MAX_BUFFERED_AMOUNT: 1024 * 1024, // 1MB 流量制御バッファ上限
        APP_SHARE_URL: 'https://galakutar.github.io/Local-P2P-Share/',
        ICE_SERVERS: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ]
    };

    // =========================================================================
    // 📦 状態管理
    // =========================================================================
    const state = {
        currentMode: 'send', // 'send' | 'receive'

        // 送信側
        senderPeer: null,
        senderPeerId: null,
        selectedFile: null,
        sendConnection: null,
        isSending: false,

        // 受信側
        receiverPeer: null,
        receiverPeerId: null,
        cameraStream: null,
        facingMode: 'environment', // 'environment' (背面) | 'user' (前面)
        isScanning: false,
        scanAnimId: null,
        receiveConnection: null,
        incomingMeta: null,
        receivedChunks: [],
        receivedBytes: 0,
        startTime: 0,

        // 画面スリープ防止
        wakeLock: null
    };

    // =========================================================================
    // 🎨 DOM要素のキャッシュ
    // =========================================================================
    const DOM = {
        // タブ切替
        tabBtnSend: document.getElementById('tab-btn-send'),
        tabBtnReceive: document.getElementById('tab-btn-receive'),
        panelSend: document.getElementById('panel-send'),
        panelReceive: document.getElementById('panel-receive'),

        // 送信画面
        dropZone: document.getElementById('drop-zone'),
        fileChooser: document.getElementById('file-chooser'),
        fileInfoCard: document.getElementById('file-info-card'),
        fileTypeIcon: document.getElementById('file-type-icon'),
        fileName: document.getElementById('file-name'),
        fileSize: document.getElementById('file-size'),
        btnResetFile: document.getElementById('btn-reset-file'),
        qrDisplayContainer: document.getElementById('qr-display-container'),
        qrcodeTarget: document.getElementById('qrcode-target'),
        senderStatusText: document.getElementById('sender-status-text'),
        sendProgressWrapper: document.getElementById('send-progress-wrapper'),
        sendProgressBar: document.getElementById('send-progress-bar'),
        sendPercent: document.getElementById('send-percent'),
        sendStatusBytes: document.getElementById('send-status-bytes'),
        sendStatusSpeed: document.getElementById('send-status-speed'),
        sendSuccessBadge: document.getElementById('send-success-badge'),

        // 受信画面
        cameraSection: document.getElementById('camera-section'),
        cameraFeed: document.getElementById('camera-feed'),
        cameraCanvas: document.getElementById('camera-canvas'),
        cameraIdle: document.getElementById('camera-idle'),
        btnActivateCamera: document.getElementById('btn-activate-camera'),
        cameraActions: document.getElementById('camera-actions'),
        btnCameraFlip: document.getElementById('btn-camera-flip'),
        btnCameraStop: document.getElementById('btn-camera-stop'),
        receiveProgressBox: document.getElementById('receive-progress-box'),
        receiveTitle: document.getElementById('receive-title'),
        receivePercent: document.getElementById('receive-percent'),
        receiveProgressBar: document.getElementById('receive-progress-bar'),
        receiveStatusBytes: document.getElementById('receive-status-bytes'),
        receiveStatusSpeed: document.getElementById('receive-status-speed'),
        receiveSuccessCard: document.getElementById('receive-success-card'),
        receivedTypeIcon: document.getElementById('received-type-icon'),
        receivedFilename: document.getElementById('received-filename'),
        receivedFilesize: document.getElementById('received-filesize'),
        receivedPreviewContainer: document.getElementById('received-preview-container'),
        btnDownloadAgain: document.getElementById('btn-download-again'),
        btnReceiveAgain: document.getElementById('btn-receive-again'),

        // トースト通知
        toast: document.getElementById('toast'),

        // アプリ共有QRモーダル
        btnOpenAppQr: document.getElementById('btn-open-app-qr'),
        btnFooterAppQr: document.getElementById('btn-footer-app-qr'),
        appQrModal: document.getElementById('app-qr-modal'),
        btnCloseAppQr: document.getElementById('btn-close-app-qr'),
        appUrlQrTarget: document.getElementById('app-url-qr-target'),
        appShareUrlInput: document.getElementById('app-share-url-input'),
        btnCopyAppUrl: document.getElementById('btn-copy-app-url')
    };

    // =========================================================================
    // 🔔 フィードバック＆ユーティリティ
    // =========================================================================
    function triggerChime() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const notes = [523.25, 659.25, 783.99, 1046.50];
            notes.forEach((freq, idx) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                const time = ctx.currentTime + idx * 0.08;
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(freq, time);
                gain.gain.setValueAtTime(0.2, time);
                gain.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.start(time);
                osc.stop(time + 0.25);
            });
        } catch (e) {}
    }

    function showNotice(msg, duration = 3000) {
        if (!DOM.toast) return;
        DOM.toast.textContent = msg;
        DOM.toast.classList.remove('hidden');
        clearTimeout(DOM.toast._timer);
        DOM.toast._timer = setTimeout(() => {
            DOM.toast.classList.add('hidden');
        }, duration);
    }

    function formatBytes(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const units = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + units[i];
    }

    function getFileIcon(type, name) {
        type = (type || '').toLowerCase();
        name = (name || '').toLowerCase();
        if (type.startsWith('video/') || name.endsWith('.mp4') || name.endsWith('.mov') || name.endsWith('.webm')) return '🎬';
        if (type.startsWith('image/') || name.endsWith('.jpg') || name.endsWith('.png') || name.endsWith('.heic')) return '🖼️';
        if (type.startsWith('audio/') || name.endsWith('.mp3') || name.endsWith('.wav') || name.endsWith('.m4a')) return '🎵';
        if (type.includes('pdf') || name.endsWith('.pdf')) return '📕';
        if (name.endsWith('.vpad-button')) return '🎛️';
        return '📄';
    }

    // 画面スリープ防止
    async function requestWakeLock() {
        try {
            if ('wakeLock' in navigator && !state.wakeLock) {
                state.wakeLock = await navigator.wakeLock.request('screen');
                state.wakeLock.addEventListener('release', () => {
                    state.wakeLock = null;
                });
            }
        } catch (e) {}
    }

    function releaseWakeLock() {
        if (state.wakeLock) {
            state.wakeLock.release().catch(() => {});
            state.wakeLock = null;
        }
    }

    // =========================================================================
    // 🌐 PeerJS 接続保証ヘルパー（iOS Safariの切断・待機に対応）
    // =========================================================================
    function ensurePeerOpen(peer) {
        return new Promise((resolve, reject) => {
            if (!peer) return reject(new Error('Peer not initialized'));
            if (peer.open && !peer.disconnected) {
                return resolve(peer.id);
            }
            if (peer.disconnected) {
                peer.reconnect();
            }

            const timer = setTimeout(() => {
                cleanup();
                if (peer.open) resolve(peer.id);
                else reject(new Error('Peer connection timeout'));
            }, 8000);

            const onOpen = (id) => {
                cleanup();
                resolve(id);
            };

            const onError = (err) => {
                cleanup();
                reject(err);
            };

            function cleanup() {
                clearTimeout(timer);
                peer.off('open', onOpen);
                peer.off('error', onError);
            }

            peer.on('open', onOpen);
            peer.on('error', onError);
        });
    }

    // =========================================================================
    // 🔄 モード切替（送信 ⇄ 受信の完全分離）
    // =========================================================================
    function switchMode(mode) {
        if (state.currentMode === mode) return;
        state.currentMode = mode;

        if (mode === 'send') {
            DOM.tabBtnSend.classList.add('active');
            DOM.tabBtnReceive.classList.remove('active');
            DOM.panelSend.classList.add('active');
            DOM.panelReceive.classList.remove('active');

            // 受信カメラを停止
            stopCamera();

            // 送信Peerの準備
            setupSenderPeer().catch(() => {});
        } else {
            DOM.tabBtnReceive.classList.add('active');
            DOM.tabBtnSend.classList.remove('active');
            DOM.panelReceive.classList.add('active');
            DOM.panelSend.classList.remove('active');

            // 受信Peerの準備 & カメラ起動
            setupReceiverPeer().catch(() => {});
            if (!state.cameraStream) {
                startCamera();
            }
        }
    }

    // =========================================================================
    // 📤 送信側ロジック（カメラ不使用・ファイル選択 ➜ 1枚の接続QR表示 ➜ 高速WebRTC送信）
    // =========================================================================
    async function setupSenderPeer() {
        if (state.senderPeer && !state.senderPeer.destroyed) {
            if (state.senderPeer.disconnected) {
                state.senderPeer.reconnect();
            }
            return await ensurePeerOpen(state.senderPeer);
        }

        const randomSuffix = Math.random().toString(36).substring(2, 10);
        state.senderPeerId = `p2pshare-${randomSuffix}`;

        state.senderPeer = new Peer(state.senderPeerId, {
            debug: 1,
            config: { iceServers: CONFIG.ICE_SERVERS }
        });

        state.senderPeer.on('connection', (conn) => {
            console.log('Incoming WebRTC connection from receiver:', conn);
            state.sendConnection = conn;
            handleSenderConnection(conn);
        });

        state.senderPeer.on('disconnected', () => {
            console.warn('Sender peer disconnected, reconnecting...');
            if (state.senderPeer && !state.senderPeer.destroyed) {
                state.senderPeer.reconnect();
            }
        });

        return await ensurePeerOpen(state.senderPeer);
    }

    async function onFileChosen(file) {
        if (!file) return;
        state.selectedFile = file;

        // UI表示更新
        DOM.fileName.textContent = file.name;
        DOM.fileSize.textContent = `${formatBytes(file.size)} • ${file.type || 'データファイル'}`;
        DOM.fileTypeIcon.textContent = getFileIcon(file.type, file.name);

        DOM.dropZone.classList.add('hidden');
        DOM.fileInfoCard.classList.remove('hidden');
        DOM.qrDisplayContainer.classList.remove('hidden');
        DOM.sendSuccessBadge.classList.add('hidden');
        DOM.sendProgressWrapper.classList.add('hidden');
        DOM.senderStatusText.textContent = '接続用QRコードを準備しています...';

        try {
            // 送信Peerを確実に接続
            const peerId = await setupSenderPeer();
            renderConnectionQR(peerId);
            DOM.senderStatusText.textContent = '受信端末の接続を待機しています...（同一Wi-Fi）';
        } catch (e) {
            console.error('Sender setup error:', e);
            DOM.senderStatusText.textContent = '接続待機中... カメラでスキャンしてください';
        }
    }

    /**
     * 接続用QRコードを1枚だけ生成・表示（ファイルデータではなく接続IDのみ！）
     */
    function renderConnectionQR(peerId) {
        if (!DOM.qrcodeTarget) return;
        DOM.qrcodeTarget.innerHTML = '';

        const connectionPayload = `p2pshare://${peerId}`;
        const qrSize = Math.min(window.innerWidth - 80, 240);

        try {
            new QRCode(DOM.qrcodeTarget, {
                text: connectionPayload,
                width: qrSize,
                height: qrSize,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            console.error('QR creation error:', e);
            DOM.qrcodeTarget.textContent = 'QRコード生成エラー';
        }
    }

    /**
     * 受信端末が接続してきた時の高速ファイル送信ハンドラ
     */
    function handleSenderConnection(conn) {
        conn.on('open', () => {
            showNotice('⚡ 受信端末とP2P接続が確立しました！データ送信を開始します');
            DOM.senderStatusText.textContent = '⚡ WebRTC P2P接続中！データを送信中...';
            DOM.sendProgressWrapper.classList.remove('hidden');
            requestWakeLock();
            startFileTransmission(conn);
        });

        conn.on('error', (err) => {
            console.error('Send connection error:', err);
            showNotice('送信接続エラーが発生しました');
        });

        conn.on('close', () => {
            console.log('Send connection closed');
            releaseWakeLock();
        });
    }

    /**
     * WebRTC DataChannelによる大容量バイナリ高速ストリーミング送信
     * （生ArrayBufferを送信し、iOS Safariのシリアライザバグを完全回避）
     */
    async function startFileTransmission(conn) {
        if (!state.selectedFile || state.isSending) return;
        state.isSending = true;

        const file = state.selectedFile;
        const totalSize = file.size;
        const chunkSize = CONFIG.CHUNK_SIZE;
        let offset = 0;
        const startTime = Date.now();

        try {
            // 1. メタデータをJSON文字列として送信
            conn.send(JSON.stringify({
                type: 'meta',
                name: file.name,
                size: totalSize,
                mime: file.type || 'application/octet-stream'
            }));

            // 2. チャンク送信ループ（生ArrayBufferを送信）
            while (offset < totalSize) {
                // バックプレッシャー（流量制御）
                if (conn.dataChannel && conn.dataChannel.bufferedAmount > CONFIG.MAX_BUFFERED_AMOUNT) {
                    await new Promise(resolve => setTimeout(resolve, 15));
                    continue;
                }

                const slice = file.slice(offset, offset + chunkSize);
                const arrayBuffer = await slice.arrayBuffer();

                // 生のArrayBufferを直接送信
                conn.send(arrayBuffer);
                offset += arrayBuffer.byteLength;

                // プログレスバー更新
                const percent = Math.min(100, Math.round((offset / totalSize) * 100));
                DOM.sendProgressBar.style.width = `${percent}%`;
                DOM.sendPercent.textContent = `${percent}%`;
                DOM.sendStatusBytes.textContent = `${formatBytes(offset)} / ${formatBytes(totalSize)}`;

                const elapsedSec = (Date.now() - startTime) / 1000;
                if (elapsedSec > 0.5) {
                    const speed = (offset / (1024 * 1024)) / elapsedSec;
                    DOM.sendStatusSpeed.textContent = `速度: ${speed.toFixed(1)} MB/s`;
                }
            }

            // 3. 完了通知をJSON文字列として送信
            conn.send(JSON.stringify({ type: 'done' }));
            state.isSending = false;

            DOM.senderStatusText.textContent = '✅ 送信が完了しました！';
            DOM.sendSuccessBadge.classList.remove('hidden');
            triggerChime();
            showNotice(`🎉 「${file.name}」の送信が完了しました！`, 4000);
        } catch (err) {
            console.error('Send failed:', err);
            state.isSending = false;
            showNotice('送信中にエラーが発生しました');
        } finally {
            releaseWakeLock();
        }
    }

    function resetSender() {
        state.selectedFile = null;
        state.isSending = false;
        DOM.fileChooser.value = '';
        DOM.qrcodeTarget.innerHTML = '';
        DOM.fileInfoCard.classList.add('hidden');
        DOM.qrDisplayContainer.classList.add('hidden');
        DOM.sendProgressWrapper.classList.add('hidden');
        DOM.sendSuccessBadge.classList.add('hidden');
        DOM.dropZone.classList.remove('hidden');
    }

    // =========================================================================
    // 📥 受信側ロジック（QR非表示・カメラで1回スキャン ➜ WebRTC接続 ➜ 高速自動保存）
    // =========================================================================
    async function setupReceiverPeer() {
        if (state.receiverPeer && !state.receiverPeer.destroyed) {
            if (state.receiverPeer.disconnected) {
                state.receiverPeer.reconnect();
            }
            return await ensurePeerOpen(state.receiverPeer);
        }

        const randomSuffix = Math.random().toString(36).substring(2, 10);
        state.receiverPeerId = `p2precv-${randomSuffix}`;

        state.receiverPeer = new Peer(state.receiverPeerId, {
            debug: 1,
            config: { iceServers: CONFIG.ICE_SERVERS }
        });

        state.receiverPeer.on('disconnected', () => {
            if (state.receiverPeer && !state.receiverPeer.destroyed) {
                state.receiverPeer.reconnect();
            }
        });

        return await ensurePeerOpen(state.receiverPeer);
    }

    async function startCamera() {
        resetReceiverUI();

        if (state.cameraStream) {
            stopCamera();
        }

        try {
            const constraints = {
                audio: false,
                video: {
                    facingMode: state.facingMode,
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            state.cameraStream = stream;
            DOM.cameraFeed.srcObject = stream;
            DOM.cameraFeed.setAttribute('playsinline', 'true');
            await DOM.cameraFeed.play();

            DOM.cameraIdle.classList.add('hidden');
            DOM.cameraActions.classList.remove('hidden');

            state.isScanning = true;
            requestAnimationFrame(scanCameraFeed);
            showNotice('カメラを起動しました。送信側の接続QRを写してください');
        } catch (err) {
            console.error('Camera open failed:', err);
            DOM.cameraIdle.classList.remove('hidden');
            DOM.cameraActions.classList.add('hidden');
            showNotice('カメラの起動に失敗しました（許可を確認してください）');
        }
    }

    function stopCamera() {
        state.isScanning = false;
        if (state.scanAnimId) {
            cancelAnimationFrame(state.scanAnimId);
            state.scanAnimId = null;
        }

        if (state.cameraStream) {
            state.cameraStream.getTracks().forEach(t => t.stop());
            state.cameraStream = null;
        }

        DOM.cameraFeed.srcObject = null;
        DOM.cameraIdle.classList.remove('hidden');
        DOM.cameraActions.classList.add('hidden');
    }

    function scanCameraFeed() {
        if (!state.isScanning) return;

        const video = DOM.cameraFeed;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            const canvas = DOM.cameraCanvas;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            if (typeof jsQR !== 'undefined') {
                const result = jsQR(imgData.data, imgData.width, imgData.height, {
                    inversionAttempts: 'dontInvert'
                });

                if (result && result.data && result.data.startsWith('p2pshare://')) {
                    onConnectionQrScanned(result.data);
                    return; // スキャン停止
                }
            }
        }

        state.scanAnimId = requestAnimationFrame(scanCameraFeed);
    }

    /**
     * 送信側の接続QRをスキャンした瞬間のハンドラ
     */
    async function onConnectionQrScanned(qrData) {
        stopCamera();
        const targetPeerId = qrData.replace('p2pshare://', '').trim();
        if (!targetPeerId) return;

        showNotice('⚡ 接続QRコードを検出！WebRTC P2P接続を開始します...');
        DOM.receiveProgressBox.classList.remove('hidden');
        DOM.receiveTitle.textContent = '⚡ 送信端末へP2P接続中...';

        await connectToSender(targetPeerId);
    }

    /**
     * WebRTCで送信端末へ接続し、データを受信
     */
    async function connectToSender(targetPeerId) {
        try {
            // 受信側Peerが準備できるのを確実に待つ
            await setupReceiverPeer();

            const conn = state.receiverPeer.connect(targetPeerId, {
                reliable: true
            });

            state.receiveConnection = conn;
            state.receivedChunks = [];
            state.receivedBytes = 0;
            state.startTime = Date.now();
            requestWakeLock();

            conn.on('open', () => {
                showNotice('⚡ P2P接続完了！高速データ受信を開始します');
                DOM.receiveTitle.textContent = '⚡ データを受信中...';
            });

            conn.on('data', (data) => {
                // 文字列の場合：メタデータまたは完了通知
                if (typeof data === 'string') {
                    try {
                        const parsed = JSON.parse(data);
                        if (parsed.type === 'meta') {
                            state.incomingMeta = parsed;
                            DOM.receiveTitle.textContent = `⚡ 「${parsed.name}」を受信中...`;
                            DOM.receiveStatusBytes.textContent = `0 MB / ${formatBytes(parsed.size)}`;
                        } else if (parsed.type === 'done') {
                            completeFileReception();
                        }
                    } catch (e) {}
                }
                // バイナリチャンク（ArrayBuffer）の場合
                else if (data instanceof ArrayBuffer || (data && data.buffer instanceof ArrayBuffer)) {
                    const chunk = data instanceof ArrayBuffer ? data : data.buffer;
                    state.receivedChunks.push(chunk);
                    state.receivedBytes += chunk.byteLength;

                    if (state.incomingMeta) {
                        const total = state.incomingMeta.size;
                        const percent = Math.min(100, Math.round((state.receivedBytes / total) * 100));
                        DOM.receiveProgressBar.style.width = `${percent}%`;
                        DOM.receivePercent.textContent = `${percent}%`;
                        DOM.receiveStatusBytes.textContent = `${formatBytes(state.receivedBytes)} / ${formatBytes(total)}`;

                        const elapsedSec = (Date.now() - state.startTime) / 1000;
                        if (elapsedSec > 0.5) {
                            const speed = (state.receivedBytes / (1024 * 1024)) / elapsedSec;
                            DOM.receiveStatusSpeed.textContent = `速度: ${speed.toFixed(1)} MB/s`;
                        }
                    }
                }
            });

            conn.on('error', (err) => {
                console.error('Receive error:', err);
                showNotice('受信中に接続エラーが発生しました');
                releaseWakeLock();
            });

            conn.on('close', () => {
                releaseWakeLock();
            });
        } catch (err) {
            console.error('Connect to sender failed:', err);
            showNotice('送信端末への接続に失敗しました。もう一度スキャンしてください');
            releaseWakeLock();
        }
    }

    /**
     * 受信完了＆自動ダウンロード
     */
    function completeFileReception() {
        if (!state.incomingMeta) return;
        releaseWakeLock();

        triggerChime();
        if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
        }

        const { name, mime, size } = state.incomingMeta;
        const blob = new Blob(state.receivedChunks, { type: mime || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);

        // 自動ダウンロード発火
        triggerAutoDownload(blobUrl, name);

        // UI表示更新
        DOM.receiveProgressBox.classList.add('hidden');
        DOM.receiveSuccessCard.classList.remove('hidden');
        DOM.receivedFilename.textContent = name;
        DOM.receivedFilesize.textContent = formatBytes(blob.size);
        DOM.receivedTypeIcon.textContent = getFileIcon(mime, name);
        DOM.btnDownloadAgain.href = blobUrl;
        DOM.btnDownloadAgain.download = name;

        // プレビュー生成（画像または動画）
        DOM.receivedPreviewContainer.innerHTML = '';
        if (mime.startsWith('image/') || name.toLowerCase().match(/\.(jpg|jpeg|png|gif|webp|heic)$/)) {
            const img = document.createElement('img');
            img.src = blobUrl;
            img.alt = name;
            DOM.receivedPreviewContainer.appendChild(img);
            DOM.receivedPreviewContainer.classList.remove('hidden');
        } else if (mime.startsWith('video/') || name.toLowerCase().match(/\.(mp4|mov|webm)$/)) {
            const video = document.createElement('video');
            video.src = blobUrl;
            video.controls = true;
            video.playsInline = true;
            DOM.receivedPreviewContainer.appendChild(video);
            DOM.receivedPreviewContainer.classList.remove('hidden');
        } else {
            DOM.receivedPreviewContainer.classList.add('hidden');
        }

        showNotice(`🎉 「${name}」を高速受信し、自動保存しました！`, 4000);
    }

    function triggerAutoDownload(url, filename) {
        const link = document.createElement('a');
        link.style.display = 'none';
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        setTimeout(() => {
            document.body.removeChild(link);
        }, 300);
    }

    function resetReceiverUI() {
        state.incomingMeta = null;
        state.receivedChunks = [];
        state.receivedBytes = 0;

        DOM.receiveProgressBox.classList.add('hidden');
        DOM.receiveSuccessCard.classList.add('hidden');
        DOM.receivedPreviewContainer.innerHTML = '';
        DOM.receiveProgressBar.style.width = '0%';
        DOM.receivePercent.textContent = '0%';
    }

    // =========================================================================
    // 📱 アプリ共有用 QRコード機能
    // =========================================================================
    function renderAppShareQr() {
        if (!DOM.appUrlQrTarget) return;
        DOM.appUrlQrTarget.innerHTML = '';

        const currentUrl = window.location.href.startsWith('http') ? window.location.href : CONFIG.APP_SHARE_URL;
        if (DOM.appShareUrlInput) {
            DOM.appShareUrlInput.value = currentUrl;
        }

        const size = Math.min(window.innerWidth - 100, 200);
        try {
            new QRCode(DOM.appUrlQrTarget, {
                text: currentUrl,
                width: size,
                height: size,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            console.error('App QR error:', e);
        }
    }

    function openAppQrModal() {
        if (!DOM.appQrModal) return;
        renderAppShareQr();
        DOM.appQrModal.classList.remove('hidden');
    }

    function closeAppQrModal() {
        if (!DOM.appQrModal) return;
        DOM.appQrModal.classList.add('hidden');
    }

    async function copyAppShareUrl() {
        const urlToCopy = DOM.appShareUrlInput ? DOM.appShareUrlInput.value : CONFIG.APP_SHARE_URL;
        try {
            await navigator.clipboard.writeText(urlToCopy);
            showNotice('🔗 アプリのURLをクリップボードにコピーしました！');
        } catch (e) {
            if (DOM.appShareUrlInput) {
                DOM.appShareUrlInput.select();
                document.execCommand('copy');
                showNotice('🔗 アプリのURLをコピーしました！');
            }
        }
    }

    // =========================================================================
    // 🎯 イベントリスナー登録
    // =========================================================================
    function bindEvents() {
        // タブ切替
        DOM.tabBtnSend.addEventListener('click', () => switchMode('send'));
        DOM.tabBtnReceive.addEventListener('click', () => switchMode('receive'));

        // ドロップゾーン
        DOM.dropZone.addEventListener('click', () => DOM.fileChooser.click());
        DOM.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            DOM.dropZone.classList.add('dragover');
        });
        DOM.dropZone.addEventListener('dragleave', () => DOM.dropZone.classList.remove('dragover'));
        DOM.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            DOM.dropZone.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                onFileChosen(e.dataTransfer.files[0]);
            }
        });

        DOM.fileChooser.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                onFileChosen(e.target.files[0]);
            }
        });

        DOM.btnResetFile.addEventListener('click', resetSender);

        // カメラ操作
        DOM.btnActivateCamera.addEventListener('click', startCamera);
        DOM.btnCameraStop.addEventListener('click', stopCamera);
        DOM.btnCameraFlip.addEventListener('click', () => {
            state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
            startCamera();
        });

        DOM.btnReceiveAgain.addEventListener('click', () => {
            resetReceiverUI();
            startCamera();
        });

        // アプリQRモーダル
        if (DOM.btnOpenAppQr) DOM.btnOpenAppQr.addEventListener('click', openAppQrModal);
        if (DOM.btnFooterAppQr) DOM.btnFooterAppQr.addEventListener('click', openAppQrModal);
        if (DOM.btnCloseAppQr) DOM.btnCloseAppQr.addEventListener('click', closeAppQrModal);
        if (DOM.appQrModal) {
            DOM.appQrModal.addEventListener('click', (e) => {
                if (e.target === DOM.appQrModal) closeAppQrModal();
            });
        }
        if (DOM.btnCopyAppUrl) DOM.btnCopyAppUrl.addEventListener('click', copyAppShareUrl);

        // 画面復帰時のPeer再接続＆省電力制御
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                if (state.isScanning) stopCamera();
            } else {
                // 画面復帰時に切断されていたら自動再接続
                if (state.currentMode === 'send' && state.senderPeer && state.senderPeer.disconnected) {
                    state.senderPeer.reconnect();
                } else if (state.currentMode === 'receive' && state.receiverPeer && state.receiverPeer.disconnected) {
                    state.receiverPeer.reconnect();
                }
            }
        });
    }

    // 初期化
    function init() {
        bindEvents();
        setupSenderPeer().catch(() => {});
        renderAppShareQr();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
