/**
 * Local-P2P-Share
 * 完全オフライン対応・対面型ローカルファイル送受信 コアスクリプト
 */

(function () {
    'use strict';

    // =========================================================================
    // ⚙️ 設定定数
    // =========================================================================
    const SETTINGS = {
        // QRコード1枚あたりの最適文字数（カメラ認識速度が最も安定するサイズ）
        QR_CHUNK_SIZE: 650,
        DEFAULT_SPEED_MS: 120, // アニメーションQRの標準コマ送り間隔
        SCAN_INTERVAL_MS: 30
    };

    // =========================================================================
    // 📦 状態管理
    // =========================================================================
    const appState = {
        currentMode: 'send', // 'send' | 'receive'

        // 送信側状態
        selectedFile: null,
        sendPackets: [],
        currentPacketIndex: 0,
        animationTimer: null,
        frameIntervalMs: SETTINGS.DEFAULT_SPEED_MS,

        // 受信側状態
        cameraStream: null,
        facingMode: 'environment', // 'environment' (背面) | 'user' (前面)
        isScanning: false,
        scanFrameReqId: null,
        activeSessionId: null,
        incomingMeta: null,
        receivedChunks: new Map(), // chunkIndex -> payload
        lastReadRaw: null
    };

    // =========================================================================
    // 🎨 DOM要素の取得
    // =========================================================================
    const el = {
        // モードタブ
        tabBtnSend: document.getElementById('tab-btn-send'),
        tabBtnReceive: document.getElementById('tab-btn-receive'),
        panelSend: document.getElementById('panel-send'),
        panelReceive: document.getElementById('panel-receive'),

        // 送信画面
        dropZone: document.getElementById('drop-zone'),
        fileChooser: document.getElementById('file-chooser'),
        fileInfoCard: document.getElementById('file-info-card'),
        fileName: document.getElementById('file-name'),
        fileSize: document.getElementById('file-size'),
        btnResetFile: document.getElementById('btn-reset-file'),
        qrDisplayContainer: document.getElementById('qr-display-container'),
        qrcodeTarget: document.getElementById('qrcode-target'),
        sendProgressWrapper: document.getElementById('send-progress-wrapper'),
        sendProgressBar: document.getElementById('send-progress-bar'),
        sendChunkLabel: document.getElementById('send-chunk-label'),
        speedRange: document.getElementById('speed-range'),

        // 受信画面
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
        receiveStatusChunks: document.getElementById('receive-status-chunks'),
        receiveStatusSize: document.getElementById('receive-status-size'),
        receiveSuccessCard: document.getElementById('receive-success-card'),
        receivedFilename: document.getElementById('received-filename'),
        receivedFilesize: document.getElementById('received-filesize'),
        receivedImagePreview: document.getElementById('received-image-preview'),
        btnDownloadAgain: document.getElementById('btn-download-again'),
        btnReceiveAgain: document.getElementById('btn-receive-again'),

        // トースト通知
        toast: document.getElementById('toast')
    };

    // =========================================================================
    // 🔔 フィードバック（音・振動・トースト）
    // =========================================================================
    function triggerChime() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const notes = [523.25, 659.25, 783.99, 1046.50]; // C5, E5, G5, C6
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

    function triggerTick() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.frequency.setValueAtTime(1100, ctx.currentTime);
            gain.gain.setValueAtTime(0.08, ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start();
            osc.stop(ctx.currentTime + 0.04);
        } catch (e) {}
    }

    function showNotice(msg, duration = 3000) {
        if (!el.toast) return;
        el.toast.textContent = msg;
        el.toast.classList.remove('hidden');
        clearTimeout(el.toast._timer);
        el.toast._timer = setTimeout(() => {
            el.toast.classList.add('hidden');
        }, duration);
    }

    function formatFileSize(bytes) {
        if (!bytes || bytes === 0) return '0 Bytes';
        const k = 1024;
        const units = ['Bytes', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
    }

    // =========================================================================
    // 🔄 モード切替（送信 ⇄ 受信の完全分離）
    // =========================================================================
    function switchMode(mode) {
        if (appState.currentMode === mode) return;
        appState.currentMode = mode;

        if (mode === 'send') {
            // 送信タブをアクティブ化
            el.tabBtnSend.classList.add('active');
            el.tabBtnReceive.classList.remove('active');
            el.panelSend.classList.add('active');
            el.panelReceive.classList.remove('active');

            // 受信カメラを確実に停止
            shutdownCamera();

            // 送信QRアニメーションを再開（ファイル読み込み済みの場合）
            if (appState.sendPackets.length > 1 && !appState.animationTimer) {
                startQrLoop();
            }
        } else {
            // 受信タブをアクティブ化
            el.tabBtnReceive.classList.add('active');
            el.tabBtnSend.classList.remove('active');
            el.panelReceive.classList.add('active');
            el.panelSend.classList.remove('active');

            // 送信側のアニメーションタイマーを一時停止（負荷削減）
            stopQrLoop();

            // 受信カメラを起動
            if (!appState.cameraStream) {
                launchCamera();
            }
        }
    }

    // =========================================================================
    // 📤 送信モードの処理（カメラ不使用・ファイル選択＆QR表示）
    // =========================================================================
    async function onFileSelected(file) {
        if (!file) return;
        appState.selectedFile = file;
        stopQrLoop();

        // UI表示更新
        el.fileName.textContent = file.name;
        el.fileSize.textContent = `${formatFileSize(file.size)} • ${file.type || 'データファイル'}`;
        
        el.dropZone.classList.add('hidden');
        el.fileInfoCard.classList.remove('hidden');
        el.qrDisplayContainer.classList.remove('hidden');

        try {
            const base64Data = await convertFileToBase64(file);
            buildPackets(file.name, file.type, file.size, base64Data);
            renderCurrentPacketQR();
            showNotice(`「${file.name}」の転送用QRを表示しました`);
        } catch (err) {
            console.error('File load failed:', err);
            showNotice('ファイルの読み込みに失敗しました');
            resetSender();
        }
    }

    function convertFileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    /**
     * ファイルをQR転送用パケットに分割
     * パケット形式: P2P1|sessionId|index|total|encodedFileName|encodedMime|chunkBase64
     */
    function buildPackets(fileName, mimeType, fileSize, base64Str) {
        const sessionId = Math.random().toString(36).substring(2, 8);
        const encName = encodeURIComponent(fileName);
        const encMime = encodeURIComponent(mimeType || 'application/octet-stream');

        const chunkSize = SETTINGS.QR_CHUNK_SIZE;
        const total = Math.ceil(base64Str.length / chunkSize) || 1;

        appState.sendPackets = [];
        appState.currentPacketIndex = 0;

        for (let i = 0; i < total; i++) {
            const chunk = base64Str.slice(i * chunkSize, (i + 1) * chunkSize);
            const packet = `P2P1|${sessionId}|${i}|${total}|${encName}|${encMime}|${chunk}`;
            appState.sendPackets.push(packet);
        }

        if (appState.sendPackets.length > 1) {
            el.sendProgressWrapper.classList.remove('hidden');
            el.sendChunkLabel.textContent = `コマ: 1 / ${total}`;
            el.sendProgressBar.style.width = `${(1 / total) * 100}%`;
        } else {
            el.sendProgressWrapper.classList.add('hidden');
        }
    }

    function renderCurrentPacketQR() {
        if (!appState.sendPackets.length) return;

        el.qrcodeTarget.innerHTML = '';
        const packet = appState.sendPackets[appState.currentPacketIndex];
        const qrSize = Math.min(window.innerWidth - 80, 240);

        try {
            new QRCode(el.qrcodeTarget, {
                text: packet,
                width: qrSize,
                height: qrSize,
                colorDark: '#000000',
                colorLight: '#ffffff',
                correctLevel: QRCode.CorrectLevel.M
            });
        } catch (e) {
            el.qrcodeTarget.textContent = 'QR生成エラー';
        }

        if (appState.sendPackets.length > 1) {
            startQrLoop();
        }
    }

    function startQrLoop() {
        stopQrLoop();
        if (appState.sendPackets.length <= 1) return;

        appState.animationTimer = setInterval(() => {
            appState.currentPacketIndex = (appState.currentPacketIndex + 1) % appState.sendPackets.length;
            
            el.qrcodeTarget.innerHTML = '';
            const packet = appState.sendPackets[appState.currentPacketIndex];
            const qrSize = Math.min(window.innerWidth - 80, 240);

            try {
                new QRCode(el.qrcodeTarget, {
                    text: packet,
                    width: qrSize,
                    height: qrSize,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.M
                });
            } catch (e) {}

            const cur = appState.currentPacketIndex + 1;
            const total = appState.sendPackets.length;
            el.sendChunkLabel.textContent = `コマ: ${cur} / ${total}`;
            el.sendProgressBar.style.width = `${(cur / total) * 100}%`;
        }, appState.frameIntervalMs);
    }

    function stopQrLoop() {
        if (appState.animationTimer) {
            clearInterval(appState.animationTimer);
            appState.animationTimer = null;
        }
    }

    function resetSender() {
        stopQrLoop();
        appState.selectedFile = null;
        appState.sendPackets = [];
        appState.currentPacketIndex = 0;

        el.fileChooser.value = '';
        el.qrcodeTarget.innerHTML = '';
        el.fileInfoCard.classList.add('hidden');
        el.qrDisplayContainer.classList.add('hidden');
        el.dropZone.classList.remove('hidden');
    }

    // =========================================================================
    // 📥 受信モードの処理（カメラスキャン＆自動ダウンロード）
    // =========================================================================
    async function launchCamera() {
        resetReceiverState();

        if (appState.cameraStream) {
            shutdownCamera();
        }

        try {
            const constraints = {
                audio: false,
                video: {
                    facingMode: appState.facingMode,
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                }
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            appState.cameraStream = stream;
            el.cameraFeed.srcObject = stream;
            el.cameraFeed.setAttribute('playsinline', 'true');
            await el.cameraFeed.play();

            el.cameraIdle.classList.add('hidden');
            el.cameraActions.classList.remove('hidden');

            appState.isScanning = true;
            requestAnimationFrame(processCameraFrame);
            showNotice('カメラを起動しました。送信側のQRコードを写してください');
        } catch (err) {
            console.error('Camera launch failed:', err);
            el.cameraIdle.classList.remove('hidden');
            el.cameraActions.classList.add('hidden');
            showNotice('カメラの起動に失敗しました（許可を確認してください）');
        }
    }

    function shutdownCamera() {
        appState.isScanning = false;
        if (appState.scanFrameReqId) {
            cancelAnimationFrame(appState.scanFrameReqId);
            appState.scanFrameReqId = null;
        }

        if (appState.cameraStream) {
            appState.cameraStream.getTracks().forEach(t => t.stop());
            appState.cameraStream = null;
        }

        el.cameraFeed.srcObject = null;
        el.cameraIdle.classList.remove('hidden');
        el.cameraActions.classList.add('hidden');
    }

    function processCameraFrame() {
        if (!appState.isScanning) return;

        const video = el.cameraFeed;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            const canvas = el.cameraCanvas;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });

            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            if (typeof jsQR !== 'undefined') {
                const qrResult = jsQR(imgData.data, imgData.width, imgData.height, {
                    inversionAttempts: 'dontInvert'
                });

                if (qrResult && qrResult.data) {
                    onQrScanned(qrResult.data);
                }
            }
        }

        appState.scanFrameReqId = requestAnimationFrame(processCameraFrame);
    }

    function onQrScanned(rawText) {
        if (!rawText.startsWith('P2P1|')) return;
        if (appState.lastReadRaw === rawText) return;
        appState.lastReadRaw = rawText;

        const parts = rawText.split('|');
        if (parts.length < 7) return;

        const [_, sessionId, idxStr, totalStr, encName, encMime, ...chunkBody] = parts;
        const idx = parseInt(idxStr, 10);
        const total = parseInt(totalStr, 10);
        const fileName = decodeURIComponent(encName);
        const mimeType = decodeURIComponent(encMime);
        const payload = chunkBody.join('|');

        // 新しいセッションが始まった場合リセット
        if (appState.activeSessionId !== sessionId) {
            appState.activeSessionId = sessionId;
            appState.receivedChunks.clear();
            appState.incomingMeta = { fileName, mimeType, total };

            el.receiveProgressBox.classList.remove('hidden');
            el.receiveTitle.textContent = `⚡ 「${fileName}」を受信中...`;
        }

        // 未取得チャンクを追加
        if (!appState.receivedChunks.has(idx)) {
            appState.receivedChunks.set(idx, payload);
            triggerTick();

            const count = appState.receivedChunks.size;
            const percent = Math.round((count / total) * 100);
            el.receiveProgressBar.style.width = `${percent}%`;
            el.receivePercent.textContent = `${percent}%`;
            el.receiveStatusChunks.textContent = `${count} / ${total} チャンク`;

            // 全チャンク受信完了！
            if (count >= total) {
                finalizeFileReception();
            }
        }
    }

    function finalizeFileReception() {
        if (!appState.incomingMeta) return;

        // 即座にカメラ停止（リソース解放）
        shutdownCamera();
        triggerChime();
        if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
        }

        const { fileName, mimeType, total } = appState.incomingMeta;

        // 全チャンクを順序通りに結合
        let fullData = '';
        for (let i = 0; i < total; i++) {
            fullData += (appState.receivedChunks.get(i) || '');
        }

        try {
            const blob = buildBlobFromDataUrl(fullData, mimeType);
            const blobUrl = URL.createObjectURL(blob);

            // 自動ダウンロード発火
            execAutoDownload(blobUrl, fileName);

            // 完了カードUI表示
            el.receiveProgressBox.classList.add('hidden');
            el.receiveSuccessCard.classList.remove('hidden');
            el.receivedFilename.textContent = fileName;
            el.receivedFilesize.textContent = formatFileSize(blob.size);
            el.btnDownloadAgain.href = blobUrl;
            el.btnDownloadAgain.download = fileName;

            // 画像の場合はプレビュー
            el.receivedImagePreview.innerHTML = '';
            if (mimeType.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = blobUrl;
                img.alt = fileName;
                el.receivedImagePreview.appendChild(img);
                el.receivedImagePreview.classList.remove('hidden');
            } else {
                el.receivedImagePreview.classList.add('hidden');
            }

            showNotice(`🎉 「${fileName}」を受信し、自動保存しました！`, 4000);
        } catch (e) {
            console.error('File reassembly failed:', e);
            showNotice('ファイルの復元に失敗しました');
        }
    }

    function execAutoDownload(url, filename) {
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

    function buildBlobFromDataUrl(dataurl, fallbackMime) {
        if (dataurl.startsWith('data:')) {
            const parts = dataurl.split(',');
            const mimeMatch = parts[0].match(/:(.*?);/);
            const mime = mimeMatch ? mimeMatch[1] : fallbackMime;
            const bstr = atob(parts[1]);
            let n = bstr.length;
            const u8 = new Uint8Array(n);
            while (n--) {
                u8[n] = bstr.charCodeAt(n);
            }
            return new Blob([u8], { type: mime });
        } else {
            const bstr = atob(dataurl);
            let n = bstr.length;
            const u8 = new Uint8Array(n);
            while (n--) {
                u8[n] = bstr.charCodeAt(n);
            }
            return new Blob([u8], { type: fallbackMime || 'application/octet-stream' });
        }
    }

    function resetReceiverState() {
        appState.activeSessionId = null;
        appState.incomingMeta = null;
        appState.receivedChunks.clear();
        appState.lastReadRaw = null;

        el.receiveProgressBox.classList.add('hidden');
        el.receiveSuccessCard.classList.add('hidden');
        el.receivedImagePreview.innerHTML = '';
        el.receiveProgressBar.style.width = '0%';
        el.receivePercent.textContent = '0%';
    }

    // =========================================================================
    // 🌐 WebRTC エンジン（将来の直接LAN DataChannel拡張用）
    // =========================================================================
    class DirectWebRtcEngine {
        constructor() {
            this.pc = null;
            this.channel = null;
        }

        async makeOffer() {
            this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            this.channel = this.pc.createDataChannel('fileTransfer', { ordered: true });
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);
            return this.waitForIce(this.pc);
        }

        async makeAnswer(offerSdp) {
            this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: offerSdp }));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);
            return this.waitForIce(this.pc);
        }

        waitForIce(pc) {
            return new Promise((resolve) => {
                if (pc.iceGatheringState === 'complete') {
                    resolve(pc.localDescription.sdp);
                } else {
                    const check = () => {
                        if (pc.iceGatheringState === 'complete') {
                            pc.removeEventListener('icegatheringstatechange', check);
                            resolve(pc.localDescription.sdp);
                        }
                    };
                    pc.addEventListener('icegatheringstatechange', check);
                    setTimeout(() => resolve(pc.localDescription ? pc.localDescription.sdp : ''), 1200);
                }
            });
        }
    }

    window.DirectWebRtcEngine = DirectWebRtcEngine;

    // =========================================================================
    // 🎯 イベントリスナーの登録
    // =========================================================================
    function bindEvents() {
        // タブ切り替え
        el.tabBtnSend.addEventListener('click', () => switchMode('send'));
        el.tabBtnReceive.addEventListener('click', () => switchMode('receive'));

        // ドロップゾーン操作
        el.dropZone.addEventListener('click', () => el.fileChooser.click());
        el.dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            el.dropZone.classList.add('dragover');
        });
        el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('dragover'));
        el.dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            el.dropZone.classList.remove('dragover');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                onFileSelected(e.dataTransfer.files[0]);
            }
        });

        el.fileChooser.addEventListener('change', (e) => {
            if (e.target.files && e.target.files.length > 0) {
                onFileSelected(e.target.files[0]);
            }
        });

        // ファイルリセット
        el.btnResetFile.addEventListener('click', resetSender);

        // 速度変更
        el.speedRange.addEventListener('change', (e) => {
            appState.frameIntervalMs = parseInt(e.target.value, 10);
            if (appState.sendPackets.length > 1 && appState.animationTimer) {
                startQrLoop();
            }
        });

        // カメラ操作
        el.btnActivateCamera.addEventListener('click', launchCamera);
        el.btnCameraStop.addEventListener('click', shutdownCamera);
        el.btnCameraFlip.addEventListener('click', () => {
            appState.facingMode = appState.facingMode === 'environment' ? 'user' : 'environment';
            launchCamera();
        });

        // もう一度受信
        el.btnReceiveAgain.addEventListener('click', () => {
            resetReceiverState();
            launchCamera();
        });

        // 画面非アクティブ時の省電力制御
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                stopQrLoop();
                if (appState.isScanning) shutdownCamera();
            } else {
                if (appState.currentMode === 'send' && appState.sendPackets.length > 1) {
                    startQrLoop();
                }
            }
        });
    }

    // 初期化実行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindEvents);
    } else {
        bindEvents();
    }

})();
