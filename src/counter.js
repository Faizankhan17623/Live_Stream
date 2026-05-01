import AgoraRTC from "agora-rtc-sdk-ng";

// RTC client instance
let client = null; 

// Initialize the AgoraRTC client
function initializeClient() {
    client = AgoraRTC.createClient({ mode: "live", codec: "vp8", role: "host" });
    setupEventListeners();
}
