/**
 * Local-P2P-Share - WebRTC DataChannel 高速ファイル転送 コアスクリプト
 * 同一Wi-Fi環境下でスマホ・タブレット・PC間で大容量ファイル（動画・写真・PDF等）を直接高速転送
 */

(function () {
    'use strict';

    // =========================================================================
    // ⚙️ 設定定数
    // =========================================================================
    const CONFIG = {
        CHUNK_SIZE: 64 * 1024,      // 64KB バイナリチャンク（WebRTC DataChannel最適値）
        MAX_BUFFERED_AMOUNT: 1024 * 1024, // 1MB バッファバックプレッシャー制御
        APP_SHARE_URL: 'https://galakutar.github.io/Local-P2P-Share/'
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
        startTime: 0
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
        if (type.startsWith('video/')) return '🎬';
        if (type.startsWith('image/')) return '🖼️';
        if (type.startsWith('audio/')) return '🎵';
        if (type.includes('pdf')) return '📕';
        if (name.endsWith('.vpad-button')) return '🎛️';
        return '📄';
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

            // 送信Peerの初期化
            initSenderPeer();
        } else {
            DOM.tabBtnReceive.classList.add('active');
            DOM.tabBtnSend.classList.remove('active');
            DOM.panelReceive.classList.add('active');
            DOM.panelSend.classList.remove('active');

            // 受信カメラを起動
            initReceiverPeer();
            if (!state.cameraStream) {
                startCamera();
            }
        }
    }

    // =========================================================================
    // 📤 送信側ロジック（カメラ不使用・ファイル選択 ➜ 1枚の接続QR表示 ➜ 高速WebRTC送信）
    // =========================================================================
    function initSenderPeer() {
        if (state.senderPeer && !state.senderPeer.destroyed) return;

        const randomSuffix = Math.random().toString(36).substring(2, 10);
        state.senderPeerId = `p2pshare-${randomSuffix}`;

        try {
            state.senderPeer = new Peer(state.senderPeerId, {
                debug: 1,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            });

            state.senderPeer.on('open', (id) => {
                state.senderPeerId = id;
                console.log('Sender Peer ready:', id);
                if (state.selectedFile) {
                    renderConnectionQR(id);
                }
            });

            state.senderPeer.on('connection', (conn) => {
                console.log('Receiver connected via WebRTC!', conn);
                state.sendConnection = conn;
                handleSenderConnection(conn);
            });

            state.senderPeer.on('error', (err) => {
                console.warn('Sender peer notice:', err);
            });
        } catch (e) {
            console.error('PeerJS init failed:', e);
        }
    }

    function onFileChosen(file) {
        if (!file) return;
        state.selectedFile = file;

        // UI更新
        DOM.fileName.textContent = file.name;
        DOM.fileSize.textContent = `${formatBytes(file.size)} • ${file.type || 'データファイル'}`;
        DOM.fileTypeIcon.textContent = getFileIcon(file.type, file.name);

        DOM.dropZone.classList.add('hidden');
        DOM.fileInfoCard.classList.remove('hidden');
        DOM.qrDisplayContainer.classList.remove('hidden');
        DOM.sendSuccessBadge.classList.add('hidden');
        DOM.sendProgressWrapper.classList.add('hidden');
        DOM.senderStatusText.textContent = '受信端末の接続を待機しています...（同一Wi-Fi）';

        initSenderPeer();
        if (state.senderPeerId) {
            renderConnectionQR(state.senderPeerId);
        }
    }

    /**
     * 接続用QRコードを1枚だけ生成・表示（ファイルデータではなく接続IDのみ！）
     */
    function renderConnectionQR(peerId) {
        if (!DOM.qrcodeTarget) return;
        DOM.qrcodeTarget.innerHTML = '';

        // 接続シグナリング用プロトコル文字列
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
            startFileTransmission(conn);
        });

        conn.on('close', () => {
            console.log('Send connection closed');
        });
    }

    /**
     * WebRTC DataChannelによる大容量バイナリ高速ストリーミング送信
     */
    async function startFileTransmission(conn) {
        if (!state.selectedFile || state.isSending) return;
        state.isSending = true;

        const file = state.selectedFile;
        const totalSize = file.size;
        const chunkSize = CONFIG.CHUNK_SIZE;
        let offset = 0;
        const startTime = Date.now();

        // 1. メタデータ送信
        conn.send({
            type: 'meta',
            name: file.name,
            size: totalSize,
            mime: file.type || 'application/octet-stream'
        });

        // 2. チャンク送信ループ（Backpressure制御付き）
        async function sendNextChunk() {
            while (offset < totalSize) {
                // バッファ詰まり防止（ブラウザがクラッシュしないよう流量制御）
                if (conn.dataChannel && conn.dataChannel.bufferedAmount > CONFIG.MAX_BUFFERED_AMOUNT) {
                    await new Promise(resolve => setTimeout(resolve, 15));
                    continue;
                }

                const slice = file.slice(offset, offset + chunkSize);
                const arrayBuffer = await slice.arrayBuffer();

                conn.send({
                    type: 'chunk',
                    data: arrayBuffer,
                    offset: offset
                });

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

            // 3. 完了通知
            conn.send({ type: 'done' });
            state.isSending = false;

            DOM.senderStatusText.textContent = '✅ 送信が完了しました！';
            DOM.sendSuccessBadge.classList.remove('hidden');
            triggerChime();
            showNotice(`🎉 「${file.name}」の送信が完了しました！`, 4000);
        }

        sendNextChunk().catch(err => {
            console.error('Send failed:', err);
            state.isSending = false;
            showNotice('送信中にエラーが発生しました');
        });
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
    function initReceiverPeer() {
        if (state.receiverPeer && !state.receiverPeer.destroyed) return;

        const randomSuffix = Math.random().toString(36).substring(2, 10);
        state.receiverPeerId = `p2precv-${randomSuffix}`;

        try {
            state.receiverPeer = new Peer(state.receiverPeerId, {
                debug: 1,
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' }
                    ]
                }
            });

            state.receiverPeer.on('open', (id) => {
                state.receiverPeerId = id;
                console.log('Receiver Peer ready:', id);
            });

            state.receiverPeer.on('error', (err) => {
                console.warn('Receiver peer notice:', err);
            });
        } catch (e) {
            console.error('Receiver PeerJS init failed:', e);
        }
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
    function onConnectionQrScanned(qrData) {
        stopCamera();
        const targetPeerId = qrData.replace('p2pshare://', '').trim();
        if (!targetPeerId) return;

        showNotice('⚡ QRコードを検出！WebRTC P2P接続を開始します...');
        DOM.receiveProgressBox.classList.remove('hidden');
        DOM.receiveTitle.textContent = '⚡ 送信端末へP2P接続中...';

        connectToSender(targetPeerId);
    }

    /**
     * WebRTCで送信端末へ接続し、データを受信
     */
    function connectToSender(targetPeerId) {
        initReceiverPeer();

        const conn = state.receiverPeer.connect(targetPeerId, {
            reliable: true
        });

        state.receiveConnection = conn;
        state.receivedChunks = [];
        state.receivedBytes = 0;
        state.startTime = Date.now();

        conn.on('open', () => {
            showNotice('⚡ P2P接続完了！高速データ受信を開始します');
            DOM.receiveTitle.textContent = '⚡ データを受信中...';
        });

        conn.on('data', (packet) => {
            if (packet.type === 'meta') {
                state.incomingMeta = packet;
                DOM.receiveTitle.textContent = `⚡ 「${packet.name}」を受信中...`;
                DOM.receiveStatusBytes.textContent = `0 MB / ${formatBytes(packet.size)}`;
            } else if (packet.type === 'chunk') {
                state.receivedChunks.push(packet.data);
                state.receivedBytes += packet.data.byteLength;

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
            } else if (packet.type === 'done') {
                completeFileReception();
            }
        });

        conn.on('error', (err) => {
            console.error('Receive error:', err);
            showNotice('受信中に接続エラーが発生しました');
        });
    }

    /**
     * 受信完了＆自動ダウンロード
     */
    function completeFileReception() {
        if (!state.incomingMeta) return;

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
        if (mime.startsWith('image/')) {
            const img = document.createElement('img');
            img.src = blobUrl;
            img.alt = name;
            DOM.receivedPreviewContainer.appendChild(img);
            DOM.receivedPreviewContainer.classList.remove('hidden');
        } else if (mime.startsWith('video/')) {
            const video = document.createElement('video');
            video.src = blobUrl;
            video.controls = true;
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

        // 画面非表示時の省電力制御
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && state.isScanning) {
                stopCamera();
            }
        });
    }

    // 初期化
    function init() {
        bindEvents();
        initSenderPeer();
        renderAppShareQr();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
