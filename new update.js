// ==UserScript==
// @name         4+1 FARABI jallal with OTP Timers
// @namespace    http://tampermonkey.net/
// @version      15.0.11.06.25.3
// @description  Easy Payment All info submission,OTP verification, payment Done with OTP timers
// @match        https://payment.ivacbd.com/*
// @grant        none
// @run-at       document-start
// @author       Sudiptta Apu
// ==/UserScript==

(function () {
    "use strict";

    // Get configuration from loader or use minimal defaults
    const CONFIG = window.IVAC_CONFIG || {
        application: {
            familyCount: "0" // Just enough to prevent errors
        },
        personal: {
            familyMembers: []
        }
    };

    // Ensure family members array matches familyCount
    CONFIG.personal.familyMembers = CONFIG.personal.familyMembers.slice(0, parseInt(CONFIG.application.familyCount));

    // API Endpoints
    const API_URLS = {
        sendOtp: "https://payment.ivacbd.com/pay-otp-sent",
        verifyOtp: "https://payment.ivacbd.com/pay-otp-verify",
        slotTime: "https://payment.ivacbd.com/pay-slot-time",
        payNow: "https://payment.ivacbd.com/paynow",
        applicationInfo: "https://payment.ivacbd.com/application-info-submit",
        personalInfo: "https://payment.ivacbd.com/personal-info-submit",
        paymentSubmit: "https://payment.ivacbd.com/overview-submit",
        capsolverCreate: "https://api.capsolver.com/createTask",
        capsolverResult: "https://api.capsolver.com/getTaskResult"
    };

    // Global State
    let globalStop = false;
    let csrfToken = null;
    let statusMessageEl = null;
    let activeRequests = [];
    let selectedDate = CONFIG.defaultDate;
    let selectedTime = null;
    let recaptchaWidgetId = null;
    let hashParam = null;
    let recaptchaToken = null;
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };
    let isRecaptchaLoaded = false;
    let isOtpVerified = false;
    let hashObserver = null;

    // CAPTCHA Solver State
    let captchaSolving = false;
    let captchaTaskId = null;

    // Parallel Click Variables
    let parallelClickInterval = null;
    let isParallelClickActive = false;
    let currentParallelButton = null;

    // Request Cancellation Variables
    const requestControllers = new Set();
    const activeXHRs = new Set();

    // OTP Timer Variables
    let otpSendTimer = null;
    let otpVerifyTimer = null;
    let sendOtpButton = null;
    let verifyButton = null;

    // ======== TIMER FUNCTIONS ========
    function startSendOtpTimer() {
        let timeLeft = 600; // 3 minutes in seconds
        clearInterval(otpSendTimer);

        const originalText = sendOtpButton.textContent;
        sendOtpButton.disabled = true;

        otpSendTimer = setInterval(() => {
            const minutes = Math.floor(timeLeft / 60);
            const seconds = timeLeft % 60;
            sendOtpButton.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

            if (timeLeft <= 0) {
                clearInterval(otpSendTimer);
                sendOtpButton.textContent = originalText;
                sendOtpButton.disabled = false;
            }
            timeLeft--;
        }, 1000);
    }

    function startVerifyTimer() {
        let timeLeft = 420; // 10 minutes in seconds
        clearInterval(otpVerifyTimer);

        const originalText = verifyButton.textContent;
        verifyButton.disabled = true;

        otpVerifyTimer = setInterval(() => {
            const minutes = Math.floor(timeLeft / 60);
            const seconds = timeLeft % 60;
            verifyButton.textContent = `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;

            if (timeLeft <= 0) {
                clearInterval(otpVerifyTimer);
                verifyButton.textContent = originalText;
                verifyButton.disabled = false;
            }
            timeLeft--;
        }, 1000);
    }

    // ======== ENHANCED FETCH INTERCEPTION ========
    const originalFetch = window.fetch;
    window.fetch = function(input, init = {}) {
        const controller = new AbortController();
        requestControllers.add(controller);

        if (init.signal) {
            init.signal.addEventListener('abort', () => controller.abort());
        }

        const newInit = {
            ...init,
            signal: controller.signal
        };

        const cleanup = () => requestControllers.delete(controller);
        return originalFetch(input, newInit).finally(cleanup);
    };

    // ======== COMPLETE XHR INTERCEPTION ========
    const OriginalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = class InterceptedXHR extends OriginalXHR {
        constructor() {
            super();
            activeXHRs.add(this);
            this.addEventListener('readystatechange', () => {
                if (this.readyState === 4) {
                    activeXHRs.delete(this);
                }
            });
        }
    };

    // Helper Functions
    function logInfo(msg) {
        if (statusMessageEl) {
            statusMessageEl.textContent = msg;
            statusMessageEl.style.color = "#5a5a5a";
        }
    }

    function logError(msg) {
        if (statusMessageEl) {
            statusMessageEl.textContent = msg;
            statusMessageEl.style.color = "#ff4444";
        }
    }

    function logSuccess(msg) {
        console.log(`[SUCCESS] ${msg}`);
        if (statusMessageEl) {
            statusMessageEl.textContent = msg;
            statusMessageEl.style.color = "#00C851";
        }

        // Start timers based on success messages
        if (msg.includes("OTP sent successfully")) {
            startSendOtpTimer();
        } else if (msg.includes("OTP verified successfully")) {
            startVerifyTimer();
        }
    }

    function retrieveCsrfToken() {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
            const match = script.innerHTML.match(/var csrf_token = "(.*?)"/);
            if (match && match[1]) {
                return match[1];
            }
        }

        const meta = document.querySelector("meta[name='csrf-token']");
        return meta?.content || document.querySelector("input[name='_token']")?.value || null;
    }

    function getHashParam() {
        const sources = [
            () => document.querySelector("input[name='hash_param']")?.value,
            () => {
                const urlParams = new URLSearchParams(window.location.search);
                return urlParams.get('hash_param');
            },
            () => {
                const inputs = document.querySelectorAll('input[type="hidden"]');
                for (let input of inputs) {
                    if (input.name.includes('hash') || input.id.includes('hash')) {
                        return input.value;
                    }
                }
                return null;
            }
        ];

        for (let source of sources) {
            const hash = source();
            if (hash) return hash;
        }

        return null;
    }

    function initializeHashParam() {
        hashParam = getHashParam();
        if (!hashObserver) {
            hashObserver = new MutationObserver(() => {
                const newHash = getHashParam();
                if (newHash && newHash !== hashParam) {
                    hashParam = newHash;
                    logInfo("Hash parameter updated dynamically");
                }
            });

            hashObserver.observe(document.body, {
                childList: true,
                subtree: true,
                attributes: true
            });
        }
    }

    async function sendPostRequest(url, data) {
        if (!csrfToken) {
            csrfToken = retrieveCsrfToken();
            if (!csrfToken) {
                logError("CSRF token not found");
                return null;
            }
        }

        data._token = csrfToken;
        const controller = new AbortController();
        activeRequests.push(controller);
        requestControllers.add(controller);

        try {
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: new URLSearchParams(data),
                signal: controller.signal,
                redirect: 'manual'
            });

            if (response.redirected || response.status === 302) {
                return { success: true, redirected: true };
            }

            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const text = await response.text();
            try {
                const jsonResponse = JSON.parse(text);

                if (url.includes('pay-otp-sent')) {
                    console.log('%cOTP Send Response:', 'color: #4CAF50; font-weight: bold', {
                        message: jsonResponse.message
                    });
                } else if (url.includes('pay-otp-verify')) {
                    console.log('%cSuccess:', 'color: #2196F3; font-weight: bold', jsonResponse.success);
                    console.log('%cMessage:', 'color: #FF9800; font-weight: bold', jsonResponse.message);
                    console.log('%cStatus:', 'color: #9C27B0; font-weight: bold', jsonResponse.data?.status);
                    console.log('%cSlot Dates:', 'color: #607D8B; font-weight: bold', jsonResponse.data?.slot_dates);
                } else if (url.includes('pay-slot-time')) {
                    console.log('%cSuccess:', 'color: #2196F3; font-weight: bold', jsonResponse.success);
                    console.log('%cMessage:', 'color: #FF9800; font-weight: bold', jsonResponse.message);
                    jsonResponse.data?.slot_times?.forEach((slot, index) => {
                        console.log('%cDate:', 'color: #009688; font-weight: bold', slot.date);
                        console.log('%cTime Display:', 'color: #ecf01a; font-weight: bold', slot.time_display);
                        console.log('%cAvailable Slots:', 'color: #23f5fc; font-weight: bold', slot.availableSlot);
                        console.log('%cHour:', 'color: #FF5722; font-weight: bold', slot.hour);
                    });
                } else if (url.includes('paynow')) {
                    console.log('%cPayNow Response:', 'color: #4CAF50; font-weight: bold', {
                        message: jsonResponse.message,
                        success: jsonResponse.success,
                        url: jsonResponse.url
                    });
                } else {
                    console.log('%cAPI Response:', 'color: #E91E63; font-weight: bold', jsonResponse);
                }

                return jsonResponse;
            } catch (e) {
                return { success: true, redirected: false };
            }

        } catch (err) {
            if (err.name !== "AbortError") {
                logError(`Request failed`);
            }
            return null;
        } finally {
            activeRequests = activeRequests.filter(req => req !== controller);
            requestControllers.delete(controller);
        }
    }

    // ======== UPDATED CAPTCHA SOLVER FUNCTIONS ========
    async function solveCaptcha() {
        if (!CONFIG.captcha.enabled) return;
        if (captchaSolving) return;

        captchaSolving = true;
        logInfo("🔄 Solving CAPTCHA...");

        try {
            const createRes = await fetch(API_URLS.capsolverCreate, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    clientKey: CONFIG.captcha.clientKey,
                    task: {
                        type: "ReCaptchaV2TaskProxyless",
                        websiteURL: CONFIG.captcha.websiteURL,
                        websiteKey: CONFIG.captcha.siteKey
                    }
                })
            });

            const createData = await createRes.json();
            if (!createData.taskId) {
                logError("Failed to create CAPTCHA task");
                captchaSolving = false;
                return;
            }

            captchaTaskId = createData.taskId;

            for (let i = 0; i < 20; i++) {
                if (globalStop) break;

                const res = await fetch(API_URLS.capsolverResult, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        clientKey: CONFIG.captcha.clientKey,
                        taskId: captchaTaskId
                    })
                });

                const data = await res.json();
                if (data.status === 'ready') {
                    recaptchaToken = data.solution.gRecaptchaResponse;
                    logSuccess("✅🎉✅ reCAPTCHA verified Successfully!");
                    updateRecaptchaResponse(recaptchaToken);
                    break;
                }

                await new Promise(r => setTimeout(r, 2000));
            }

            if (!recaptchaToken) {
                logError("CAPTCHA solve failed or timed out");
            }
        } catch (error) {
            logError(`CAPTCHA solve error: ${error.message}`);
        } finally {
            captchaSolving = false;
        }
    }

    function updateRecaptchaResponse(token) {
        let textarea = document.getElementById("g-recaptcha-response");
        if (!textarea) {
            textarea = document.createElement("textarea");
            textarea.id = "g-recaptcha-response";
            textarea.name = "g-recaptcha-response";
            textarea.style.display = "none";
            document.body.appendChild(textarea);
        }

        textarea.value = token;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function waitForCaptcha() {
        return new Promise(resolve => {
            const interval = setInterval(() => {
                const iframe = document.querySelector('iframe[src*="recaptcha"]');
                if (iframe) {
                    clearInterval(interval);
                    resolve();
                }
            }, 1000);
        });
    }

    // ======== RECAPTCHA LOADER ========
    function loadRecaptcha() {
        if (isRecaptchaLoaded) {
            grecaptcha.reset(recaptchaWidgetId);
            return;
        }

        return new Promise((resolve) => {
            const recaptchaContainer = document.getElementById("ivac-recaptcha-container");
            recaptchaContainer.innerHTML = '';
            const cleanContainer = document.createElement('div');
            cleanContainer.id = 'ivac-recaptcha-wrapper';
            recaptchaContainer.appendChild(cleanContainer);

            cleanContainer.innerHTML = `
                <div class="g-recaptcha" id="ivac-recaptcha"
                     data-sitekey="${CONFIG.captcha.siteKey}"
                     data-callback="onRecaptchaVerify"
                     data-expired-callback="onRecaptchaExpired"
                     data-error-callback="onRecaptchaError"
                     style="transform:scale(0.85);transform-origin:0 0">
                </div>
            `;

            const script = document.createElement("script");
            script.src = `https://www.google.com/recaptcha/api.js?render=explicit&onload=onRecaptchaLoad`;
            script.async = true;
            script.defer = true;

            window.onRecaptchaLoad = () => {
                try {
                    recaptchaWidgetId = grecaptcha.render("ivac-recaptcha", {
                        sitekey: CONFIG.captcha.siteKey,
                        theme: 'light',
                        callback: (token) => {
                            recaptchaToken = token;
                            logSuccess("✅ reCAPTCHA verified Successfully!");
                        },
                        'expired-callback': () => {
                            recaptchaToken = null;
                            logInfo("reCAPTCHA expired, auto-solving...");
                            solveCaptcha();
                        },
                        'error-callback': () => {
                            recaptchaToken = null;
                            logError("reCAPTCHA verification failed, auto-solving...");
                            solveCaptcha();
                        }
                    });
                    isRecaptchaLoaded = true;

                    if (CONFIG.captcha.enabled) {
                        solveCaptcha();
                    }

                    resolve();
                } catch (e) {
                    logError("Failed to load reCAPTCHA: " + e.message);
                }
            };

            document.body.appendChild(script);
        });
    }

    function reloadCaptcha() {
        logInfo("Reloading reCAPTCHA...");
        recaptchaToken = null;
        if (isRecaptchaLoaded) {
            try {
                grecaptcha.reset(recaptchaWidgetId);
                document.querySelectorAll('#ivac-recaptcha-wrapper [aria-hidden]').forEach(el => {
                    el.removeAttribute('aria-hidden');
                });
                solveCaptcha();
            } catch (e) {
                logError("Error resetting reCAPTCHA: " + e.message);
            }
        } else {
            loadRecaptcha();
        }
    }

    // ======== PAY NOW HANDLER ========
    async function handlePayNow() {
        if (isParallelClickActive && currentParallelButton?.textContent === "Pay Now") {
            // Skip if already in parallel mode
            ;
        }

        logInfo("Processing payment...");

        if (!recaptchaToken) {
            logError("⚠️ CAPTCHA not solved yet. Trying to solve...");
            await solveCaptcha();
            if (!recaptchaToken) {
                logError("⚠️ Failed to solve CAPTCHA. Please try again.");
                return;
            }
        }

        if (!selectedDate) {
            logError("⚠️ Select appointment date");
            return;
        }

        let slotHour = selectedTime;

        if (!slotHour) {
            const timeDropdown = document.getElementById('ivac-time-dropdown');
            if (timeDropdown && timeDropdown.options.length > 1) {
                slotHour = timeDropdown.options[1].value;
                logInfo(`Using first available slot hour from dropdown: ${slotHour}`);
            } else {
                slotHour = "9";
                logInfo("Using default slot hour: 9");
            }
        }

        const paymentData = {
            _token: csrfToken,
            appointment_date: selectedDate,
            appointment_time: slotHour,
            hash_param: recaptchaToken,
            'selected_payment[name]': "VISA",
            'selected_payment[slug]': "visacard",
            'selected_payment[link]': "https://securepay.sslcommerz.com/gwprocess/v4/image/gw1/visa.png"
        };

        try {
            const response = await fetch(API_URLS.payNow, {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: new URLSearchParams(paymentData)
            });

            const result = await response.json();
            console.log("%cPayment API response:", "color: #ff8503; font-weight: bold", result);

            if (result.success && result.url) {
                logSuccess(" 🎉 🎉 🎉 Payment URL generated");
                console.log('Opening Payment URL:', result.url);
                window.open(result.url, '_blank');
            } else {
                logError(result?.message || "Payment failed");
            }
        } catch (error) {
         /*   logError(`Payment error: ${error.message}`); */
        }
    }

    // OTP Functions
    async function sendOtp(resend = false) {
        logInfo(resend ? "Resending OTP..." : "Sending OTP...");

        try {
            const result = await sendPostRequest(API_URLS.sendOtp, {
                _token: csrfToken,
                resend: resend ? 1 : 0
            });

            if (result?.success) {
                logSuccess(`✅ OTP ${resend ? 're' : ''}sent successfully`);
                return true;
            } else {
                const errorMsg = result?.message || 'Unknown error';
                logError(`Failed to ${resend ? 're' : ''}send OTP: ${errorMsg}`);
                return false;
            }
        } catch (error) {
            logError(`Network error during OTP ${resend ? 're' : ''}send`);
            return false;
        }
    }

    async function verifyOtp() {
        const otp = document.getElementById("ivac-otp-input")?.value;
        if (!otp || otp.length !== 6) {
            logError("Please enter 6-digit OTP");
            return;
        }

        logInfo("Verifying OTP...");
        const result = await sendPostRequest(API_URLS.verifyOtp, { otp });
        if (result?.success) {
            isOtpVerified = true;
            logSuccess("✅ OTP verified successfully!");
            hashParam = result.data?.hash_param || getHashParam();
            updateDatePicker(result.data?.slot_dates || []);
        } else if (result) {
            logError("✗ Invalid OTP");
        }
    }

    async function getSlotTimes() {
        if (!selectedDate) {
            logError("Please select a date first");
            return;
        }

        logInfo(`Fetching slots for ${selectedDate}...`);
        const result = await sendPostRequest(API_URLS.slotTime, { appointment_date: selectedDate });
        if (result?.success) {
            logSuccess("✓ Slots load successfully!");
            updateTimeDropdown(result.data?.slot_times || []);
            loadRecaptcha();
        } else if (result) {
            logError("Failed to load slots");
        }
    }

    // Application Info Functions
    async function submitApplicationInfo() {
        logInfo("Submitting application info...");
        const result = await sendPostRequest(API_URLS.applicationInfo, {
            highcom: CONFIG.application.highcom,
            webfile_id: CONFIG.application.webFileId,
            webfile_id_repeat: CONFIG.application.webFileId,
            ivac_id: CONFIG.application.ivacId,
            visa_type: CONFIG.application.visaType,
            family_count: CONFIG.application.familyCount,
            visit_purpose: CONFIG.application.visitPurpose
        });

        if (result?.success) {
            if (result.redirected) {
                console.log("✅ Application info Successful!");
                logSuccess("✓ Application info submitted");
            } else {
                logSuccess("✓ Application info submitted");
            }
        } else if (result) {
            logError("Application submission failed");
        }
    }

    // Personal Info Functions
    async function submitPersonalInfo() {
        logInfo("Submitting personal info...");
        const formData = {
            full__name: CONFIG.personal.fullName,
            email_name: CONFIG.personal.email,
            pho_ne: CONFIG.personal.phone,
            web_file_id: CONFIG.application.webFileId
        };

        const familyCount = parseInt(CONFIG.application.familyCount) || 0;

        for (let i = 0; i < familyCount && i < CONFIG.personal.familyMembers.length; i++) {
            const member = CONFIG.personal.familyMembers[i];
            if (member.name && member.webFileNo) {
                const familyIndex = i + 1;
                formData[`family[${familyIndex}][name]`] = member.name;
                formData[`family[${familyIndex}][webfile_no]`] = member.webFileNo;
                formData[`family[${familyIndex}][again_webfile_no]`] = member.webFileNo;
            }
        }

        const result = await sendPostRequest(API_URLS.personalInfo, formData);
        if (result?.success) {
            if (result.redirected) {
                console.log("✅ Personal Info Successful!");
                logSuccess("✓ Personal info submitted");
            } else {
                logSuccess("✓ Personal info submitted");
            }
        } else if (result) {
            logError("Personal submission failed");
        }
    }

    // Payment Submit Function
    async function submitPayment() {
        logInfo("Initiating payment...");
        const result = await sendPostRequest(API_URLS.paymentSubmit, {});

        if (result?.success) {
            if (result.redirected) {
                console.log("✅ Payment Successful!");
                logSuccess("✓ Payment initiated");
            } else {
                logSuccess("✓ Payment initiated");
            }
            if (result.data?.redirect_url) {
                window.open(result.data.redirect_url, '_blank');
            }
        } else if (result) {
            logError("Payment initiation failed");
        }
    }

    // Time Injector Function
    function injectTimeSlots() {
        let timeDropdown = document.getElementById('appointment_time');
        if (!timeDropdown) {
            timeDropdown = document.getElementById('ivac-time-dropdown');
        }

        if (timeDropdown) {
            timeDropdown.innerHTML = '<option value="">Select an Appointment Time</option><option value="10">10:00 - 10:59</option>';
            timeDropdown.style.display = '';
            timeDropdown.classList.remove('d-none');
            logSuccess("Time slots injected successfully");

            if (timeDropdown.id === 'ivac-time-dropdown') {
                selectedTime = "10";
            }
        } else {
            logError("Time dropdown element not found");
        }
    }

    // UI Update Functions
    function updateDatePicker(dates) {
        const dateInput = document.getElementById("ivac-date-input");
        if (!dateInput) return;

        if (dates.length > 0) {
            const sortedDates = dates.sort();
            dateInput.min = sortedDates[0];
            dateInput.max = sortedDates[sortedDates.length - 1];
        }

        dateInput.value = CONFIG.defaultDate;
        selectedDate = CONFIG.defaultDate;

        dateInput.onchange = async (e) => {
            selectedDate = e.target.value;
            if (selectedDate) {
                document.getElementById("ivac-time-dropdown").innerHTML = '<option value="">Select Time</option>';
                await getSlotTimes();
            }
        };
    }

    function updateTimeDropdown(times) {
        const dropdown = document.getElementById("ivac-time-dropdown");
        if (!dropdown) return;

        dropdown.innerHTML = '<option value="">Select Time</option>';

        times.forEach(time => {
            if (time.date === selectedDate) {
                const option = document.createElement("option");
                option.value = time.hour;
                option.textContent = time.time_display;
                option.dataset.available = time.availableSlot;
                dropdown.appendChild(option);
            }
        });

        if (dropdown.options.length === 1) {
            logError("No available slots for selected date");
        }

        dropdown.onchange = (e) => {
            selectedTime = e.target.value;
        };
    }

    // UI Components
    function createButton(text, onClick, color, hoverColor, width = 'auto') {
        const btn = document.createElement("button");
        btn.textContent = text;
        btn.onclick = onClick;

        if (text === "Send OTP") {
            sendOtpButton = btn;
        } else if (text === "Verify") {
            verifyButton = btn;
        }

        if (text !== "Cancel") {
            setupParallelClick(btn, onClick);
        }

        btn.style.cssText = `
            padding: 8px 12px;
            margin: 0;
            width: ${width};
            background: ${color};
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 12px;
            font-weight: 500;
            transition: all 0.2s ease;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            text-transform: uppercase;
            letter-spacing: 0.5px;
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            white-space: nowrap;
            position: relative;
        `;

        btn.onmouseover = () => {
            btn.style.background = hoverColor;
            btn.style.transform = "translateY(-1px)";
            btn.style.boxShadow = "0 4px 8px rgba(0,0,0,0.15)";
        };

        btn.onmouseout = () => {
            btn.style.background = color;
            btn.style.transform = "translateY(0)";
            btn.style.boxShadow = "0 2px 4px rgba(0,0,0,0.1)";
        };

        return btn;
    }

    function createInputField() {
        const container = document.createElement("div");
        container.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 8px 0;
        `;

        const input = document.createElement("input");
        input.id = "ivac-otp-input";
        input.type = "text";
        input.maxLength = 6;
        input.placeholder = "6-digit OTP";
        input.style.cssText = `
            padding: 8px 12px;
            width: 89px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            font-size: 11px;
            box-sizing: border-box;
            transition: all 0.3s ease;
            outline: none;
            background: rgba(255,255,255,0.8);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
        `;

        const verifyBtn = createButton("Verify", verifyOtp, "rgba(66,133,244,0.8)", "rgba(66,133,244,1)", "80px");
        const slotBtn = createButton("Pay Time", getSlotTimes, "rgba(104,58,183,0.8)", "rgba(104,58,183,1)", "80px");

        container.appendChild(input);
        container.appendChild(verifyBtn);
        container.appendChild(slotBtn);
        return container;
    }

    function createDateTimeDropdowns() {
        const container = document.createElement("div");
        container.style.cssText = `
            display: flex;
            gap: 8px;
            align-items: center;
            margin: 8px 0;
        `;

        const dateContainer = document.createElement("div");
        dateContainer.style.cssText = `
            display: flex;
            align-items: center;
            flex: 1;
        `;

        const dateInput = document.createElement("input");
        dateInput.id = "ivac-date-input";
        dateInput.type = "date";
        dateInput.style.cssText = `
            padding: 6px 12px;
            width: 100%;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            font-size: 12px;
            box-sizing: border-box;
            background: rgba(255,255,255,0.8);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
            cursor: pointer;
        `;
        dateContainer.appendChild(dateInput);

        const timeContainer = document.createElement("div");
        timeContainer.style.cssText = `
            display: flex;
            align-items: center;
            flex: 1;
        `;

        const timeSelect = document.createElement("select");
        timeSelect.id = "ivac-time-dropdown";
        timeSelect.name = "appointment_time";
        timeSelect.style.cssText = `
            padding: 8px 12px;
            width: 96%;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px;
            font-size: 12px;
            box-sizing: border-box;
            background: rgba(255,255,255,0.8);
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
            cursor: pointer;
        `;
        timeSelect.innerHTML = '<option value="">Select Time</option>';
        timeContainer.appendChild(timeSelect);

        container.appendChild(dateContainer);
        container.appendChild(timeContainer);
        return container;
    }

    function createStatusPanel() {
        const panel = document.createElement("div");
        panel.id = "ivac-status-panel";
        panel.style.cssText = `
            padding: 10px;
            margin: 0 0 10px 0;
            background: rgba(255,255,255,0.8);
            border-radius: 6px;
            border: 1px solid rgba(255,255,255,0.2);
            font-size: 12px;
            min-height: 20px;
            word-break: break-word;
            text-align: center;
            transition: all 0.3s ease;
            backdrop-filter: blur(5px);
            -webkit-backdrop-filter: blur(5px);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            color: #333;
        `;
        return panel;
    }

    // Draggable Panel Functionality
    function makeDraggable(panel, header) {
        header.style.cursor = 'move';

        header.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;

            isDragging = true;
            dragOffset = {
                x: e.clientX - panel.getBoundingClientRect().left,
                y: e.clientY - panel.getBoundingClientRect().top
            };

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            panel.style.left = `${e.clientX - dragOffset.x}px`;
            panel.style.top = `${e.clientY - dragOffset.y}px`;
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });
    }

    // Parallel Click Functions
    function setupParallelClick(button, clickHandler) {
        if (button.textContent === "Cancel") {
            return;
        }

        let clickCount = 0;
        let timeoutId = null;

        button.addEventListener('click', function() {
            clickCount++;

            if (clickCount === 1) {
                timeoutId = setTimeout(() => {
                    if (isParallelClickActive && currentParallelButton === button) {
                        stopParallelClick();
                        logInfo("❌ Parallel clicking stopped");
                    }
                    clickCount = 0;
                }, 500);
            } else if (clickCount === 2) {
                clearTimeout(timeoutId);
                if (!isParallelClickActive || currentParallelButton !== button) {
                    startParallelClick(button, clickHandler);
                    logInfo("Parallel clicking started");
                }
                clickCount = 0;
            }
        });
    }

    function startParallelClick(button, clickHandler) {
        if (isParallelClickActive) {
            stopParallelClick();
        }

        isParallelClickActive = true;
        currentParallelButton = button;
        clickHandler();
        parallelClickInterval = setInterval(clickHandler, 1424);

        button.style.boxShadow = `0 0 10px 2px ${button.style.background}`;
        button.style.transform = "scale(1.05)";
    }

    function stopParallelClick() {
        if (!isParallelClickActive) return;

        isParallelClickActive = false;
        clearInterval(parallelClickInterval);
        parallelClickInterval = null;

        if (currentParallelButton) {
            currentParallelButton.style.boxShadow = "0 2px 4px rgba(0,0,0,0.1)";
            currentParallelButton.style.transform = "scale(1)";
            currentParallelButton = null;
        }
    }

    // Request Cancellation Function
    function cancelAllRequests() {
        const originalMessage = statusMessageEl.textContent;
        statusMessageEl.textContent = "Canceling all requests...";
        statusMessageEl.style.color = "#ff4444";

        requestControllers.forEach(controller => controller.abort());
        requestControllers.clear();

        activeXHRs.forEach(xhr => xhr.abort());
        activeXHRs.clear();

        stopParallelClick();
        activeRequests = [];

        setTimeout(() => {
            statusMessageEl.textContent = "✓ All requests canceled";
            statusMessageEl.style.color = "#00C851";
            setTimeout(() => {
                statusMessageEl.textContent = originalMessage;
                statusMessageEl.style.color = "#5a5a5a";
            }, 2000);
        }, 300);
    }

    function createTopRightUI() {
        const mainContainer = document.createElement("div");
        mainContainer.id = "ivac-payment-container";
        mainContainer.style.cssText = `
            position: fixed;
            right: 10px;
            top: 40px;
            z-index: 9999;
            background: linear-gradient(135deg, rgba(255,255,255,0.3), rgba(255,255,255,0.1));
            padding: 15px;
            border-radius: 12px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.1);
            width: 300px;
            border: 1px solid rgba(255,255,255,0.2);
            font-family: 'Inter', 'Segoe UI', Roboto, sans-serif;
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            overflow: hidden;
            user-select: none;
        `;

        const borderEffect = document.createElement("div");
        borderEffect.style.cssText = `
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: linear-gradient(90deg, #4285f4, #34a853, #fbbc05, #ea4335);
            z-index: 9998;
        `;
        mainContainer.appendChild(borderEffect);

        const title = document.createElement("h3");
        title.textContent = "IVAC PAYMENT GURU";
        title.style.cssText = `
            margin: 0 0 12px 0;
            padding: 0;
            font-size: 14px;
            color: #333;
            font-weight: 600;
            text-align: center;
            letter-spacing: 1px;
            text-transform: uppercase;
            text-shadow: 0 1px 2px rgba(0,0,0,0.1);
            cursor: move;
        `;
        mainContainer.appendChild(title);

        statusMessageEl = createStatusPanel();
        statusMessageEl.textContent = "Ready";
        mainContainer.appendChild(statusMessageEl);

        const appButtonsContainer = document.createElement("div");
        appButtonsContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        `;
        appButtonsContainer.appendChild(
            createButton("App Info", submitApplicationInfo, "rgba(7, 118, 237, 0.8)", "rgba(7, 118, 237, 1)", "calc(33% - 6px)")
        );
        appButtonsContainer.appendChild(
            createButton("Per Info", submitPersonalInfo, "rgba(154, 82, 255, 0.8)", "rgba(154, 82, 255, 1)", "calc(33% - 6px)")
        );
        appButtonsContainer.appendChild(
            createButton("Payment", submitPayment, "rgba(255, 118, 60, 0.8)", "rgba(255, 118, 60, 1)", "calc(34% - 6px)")
        );
        mainContainer.appendChild(appButtonsContainer);

        const sendResendContainer = document.createElement("div");
        sendResendContainer.style.cssText = `
            display: flex;
            gap: 8px;
            margin-bottom: 8px;
        `;
        sendResendContainer.appendChild(
            createButton("Send OTP", () => sendOtp(false), "rgba(52,168,83,0.8)", "rgba(52,168,83,1)", "calc(33.33% - 6px)")
        );
        sendResendContainer.appendChild(
            createButton("Resend", () => sendOtp(true), "rgba(251,188,5,0.8)", "rgba(251,188,5,1)", "calc(33.33% - 6px)")
        );
        sendResendContainer.appendChild(
            createButton("Cancel", cancelAllRequests, "rgba(255,20,0,0.8)", "rgba(0,25,255,1)", "calc(33.33% - 6px)")
        );
        mainContainer.appendChild(sendResendContainer);

        mainContainer.appendChild(createInputField());
        mainContainer.appendChild(createDateTimeDropdowns());

        const recaptchaContainer = document.createElement("div");
        recaptchaContainer.id = "ivac-recaptcha-container";
        recaptchaContainer.style.cssText = `
            margin: 10px 0;
            min-height: 78px;
            display: flex;
            justify-content: left;
        `;
        mainContainer.appendChild(recaptchaContainer);

        const actionButtons = document.createElement("div");
        actionButtons.style.cssText = `
            display: flex;
            gap: 8px;
            margin-top: 10px;
        `;

        actionButtons.appendChild(
            createButton("Re-Cap", reloadCaptcha, "rgba(255,152,0,0.8)", "rgba(255,152,0,1)", "91px")
        );

        actionButtons.appendChild(
            createButton("Pay Now", handlePayNow, "rgba(233,30,99,0.8)", "rgba(233,30,99,1)", "80px")
        );

        actionButtons.appendChild(
            createButton("TIME", injectTimeSlots, "rgba(63,81,181,0.8)", "rgba(63,81,181,1)", "80px")
        );

        mainContainer.appendChild(actionButtons);

        mainContainer.style.opacity = "0";
        mainContainer.style.transform = "translateY(-20px) scale(0.95)";
        mainContainer.style.transition = "all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)";

        setTimeout(() => {
            mainContainer.style.opacity = "1";
            mainContainer.style.transform = "translateY(0) scale(1)";
        }, 100);

        document.body.appendChild(mainContainer);

        makeDraggable(mainContainer, title);

        const dateInput = document.getElementById("ivac-date-input");
        if (dateInput) {
            dateInput.onchange = async (e) => {
                selectedDate = e.target.value;
                if (selectedDate) {
                    document.getElementById("ivac-time-dropdown").innerHTML = '<option value="">Select Time</option>';
                    await getSlotTimes();
                }
            };
        }
    }

    // Initialize when page loads
    window.addEventListener("load", function() {
        // Your existing initialization code
        csrfToken = retrieveCsrfToken();
        initializeHashParam();
        createTopRightUI();
        logInfo(csrfToken ? "I AM READY TO BOOK SLOTS" : "CSRF auto-detected");
     /*   console.log("Current Configuration:", CONFIG); */

        if (CONFIG.captcha.enabled) {
            waitForCaptcha().then(() => {
                logInfo("💡🔄 CAPTCHA detected - starting auto-solve...");
                solveCaptcha();
            });
        }
    });
})();


// ALL Function /////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


//tab reloader

function reloadPageOnTimeout() {
    let reloadInterval = setInterval(function () {
        // Don't reload if we're on a payment status page
        if (window.location.pathname.match(/^\/multi_payment\/status\//)) {
            return;
        }

        // Check for timeout/error conditions
        const heading = document.querySelector('h1');
        const errorCodeElements = document.querySelectorAll('[class*="error"], [class*="code"], [class*="status"], [id*="error"], [id*="code"], [id*="status"]');

        // Check for timeout heading
        if (heading && heading.innerText !== 'Application fee change notice') {
            location.reload();
            clearInterval(reloadInterval);
            return;
        }

        // Check for error codes (500, 502, 504, 505, etc.)
        for (const element of errorCodeElements) {
            const text = element.innerText.trim();
            if (/^(5[0-9]{2})$/.test(text)) {
                location.reload();
                clearInterval(reloadInterval);
                return;
            }
        }

        // Additional check for common 500 error text
        if (document.body.innerText.includes('Server Error') ||
            document.body.innerText.includes('Internal Server Error')) {
            location.reload();
            clearInterval(reloadInterval);
            return;
        }
    }, 1001); // Check every 1001ms
}

// Start the monitoring
reloadPageOnTimeout();

//tab reloader


    //Copy paste allowed
   (function() {
       'use strict';

    // Main function to remove copy-paste restrictions
    function enableCopyPaste() {
        try {
            // Process all existing input/textarea elements
            document.querySelectorAll('input, textarea, [contenteditable="true"]').forEach(el => {
                // Remove restrictive attributes
                const attrs = ['stopccp', 'onpaste', 'oncopy', 'oncut', 'oninput', 'onkeydown', 'oncontextmenu'];
                attrs.forEach(attr => el.removeAttribute(attr));

                // Nullify event handlers
                const events = ['paste', 'copy', 'cut', 'input', 'keydown', 'contextmenu'];
                events.forEach(evt => {
                    try {
                        el[`on${evt}`] = null;
                    } catch (e) {}
                });

                // Allow paste events
                el.addEventListener('paste', stopEventPropagation, true);
                el.addEventListener('copy', stopEventPropagation, true);
                el.addEventListener('cut', stopEventPropagation, true);
            });

            // Remove body-level restrictions (if body exists)
            if (document.body) {
                const bodyEvents = ['paste', 'copy', 'cut'];
                bodyEvents.forEach(evt => {
                    try {
                        document.body[`on${evt}`] = null;
                    } catch (e) {}
                });
            }
        } catch (error) {
            console.warn('CopyPasteEnabler error:', error);
        }
    }

    // Helper function to stop event propagation
    function stopEventPropagation(e) {
        e.stopPropagation();
        e.stopImmediatePropagation();
        return true;
    }

    // Initialize with different strategies based on page state
    function init() {
        // First immediate run
        enableCopyPaste();

        // Periodic check (every 1 second)
        const intervalId = setInterval(enableCopyPaste, 1000);

        // MutationObserver for dynamically added elements
        const observer = new MutationObserver(function(mutations) {
            enableCopyPaste();
        });

        observer.observe(document, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['onpaste', 'oncopy', 'oncut']
        });

        // Cleanup when page unloads
        window.addEventListener('unload', function() {
            clearInterval(intervalId);
            observer.disconnect();
        });

    }

    // Start the script when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Also run on window load in case some restrictions are applied late
    window.addEventListener('load', init);
})();

//Copy paste allowed


// Alart popup close by Sudiptta Apu

function closeModal() {
    let closeButton = document.getElementById('emergencyNoticeCloseBtn');

    if (closeButton) {
        closeButton.click();
     /*   console.log(' Emergency notice close button clicked.'); */
    } else {

        let checkButton = setInterval(() => {
            let closeButton = document.getElementById('emergencyNoticeCloseBtn');
            if (closeButton) {
                closeButton.click();
                console.log(' Emergency notice close button clicked (delayed).');
                clearInterval(checkButton);
            }
        }, 100); // Retry every 500ms
    }

    let modal = document.getElementById('instructModal');
    if (modal) {
        modal.setAttribute('inert', ''); // Prevent interaction but keep accessibility
        modal.style.display = 'none'; // Hide modal
        document.body.classList.remove('modal-open'); // Fix body scrolling issue

        let backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) backdrop.remove(); // Remove Bootstrap backdrop

        // Ensure focus is shifted away from the hidden modal
        document.body.focus();

      /*  console.log(' Modal closed properly.'); */
    }
}

// Ensure the script runs **after** page load and retries if needed
window.addEventListener('load', function () {
    setTimeout(closeModal, 500); // Delay to wait for elements to load
});


// Alart popup close by Sudiptta Apu


// Alart POPUP HIDE
(function() {
    'use strict';

    function closePopup() {
        let okButton = document.querySelector("#messageModal .modal-footer button");
        if (okButton) {
            okButton.click();
            console.log("Popup closed");
        }
    }

    setInterval(closePopup, 1000);
})();

// Alart POPUP HIDE
// @grant        GM_setClipboard
// @grant        GM_notification
// @require      https://greasyfork.org/scripts/470206-gm-notification/code/GM_notification.js?version=1155815

(function() {
    'use strict';

    // Wait for DOM to be fully ready
    function domReady() {
        return new Promise(resolve => {
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                setTimeout(resolve, 100);
            } else {
                document.addEventListener('DOMContentLoaded', resolve);
                window.addEventListener('load', resolve);
            }
        });
    }

    async function init() {
        await domReady();

        // Check if we're on the correct page
        if (!document.body) {
            console.warn('Document body not found');
            return;
        }

        createPopupUI();
        setupRequestInterception();

    }

    function createPopupUI() {
        // Create popup container
        const popup = document.createElement('div');
        popup.id = 'paymentLinkPopup';
        popup.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background-color: rgba(0,0,0,0.9);
            z-index: 99999;
            display: none;
            justify-content: center;
            align-items: center;
        `;

        // Create popup content
        const popupContent = document.createElement('div');
        popupContent.style.cssText = `
            background-color: #1a1a1a;
            padding: 30px;
            border-radius: 10px;
            width: 80%;
            max-width: 600px;
            text-align: center;
            border: 2px solid #d32f2f;
        `;

        // Create title
        const title = document.createElement('h2');
        title.textContent = 'PAYMENT LINK GENERATED';
        title.style.cssText = `
            margin-top: 0;
            color: #d32f2f;
            font-family: Arial, sans-serif;
        `;

        // Create URL display
        const urlDisplay = document.createElement('div');
        urlDisplay.id = 'paymentUrlDisplay';
        urlDisplay.style.cssText = `
            word-break: break-all;
            padding: 15px;
            margin: 20px 0;
            background-color: #2a2a2a;
            border-radius: 5px;
            font-family: monospace;
            color: #4CAF50;
            border: 1px solid #444;
            max-height: 200px;
            overflow-y: auto;
        `;

        // Create buttons container
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = `
            display: flex;
            justify-content: center;
            gap: 10px;
        `;

        // Create copy button
        const copyBtn = document.createElement('button');
        copyBtn.textContent = 'COPY LINK';
        copyBtn.style.cssText = `
            padding: 12px 25px;
            background-color: #d32f2f;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-weight: bold;
        `;

        // Create close button
        const closeBtn = document.createElement('button');
        closeBtn.textContent = 'CLOSE';
        closeBtn.style.cssText = `
            padding: 12px 25px;
            background-color: #333;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
        `;

        // Assemble components
        btnContainer.appendChild(copyBtn);
        btnContainer.appendChild(closeBtn);
        popupContent.appendChild(title);
        popupContent.appendChild(urlDisplay);
        popupContent.appendChild(btnContainer);
        popup.appendChild(popupContent);

        // Safely add to DOM
        const body = document.body;
        if (body) {
            body.appendChild(popup);

        } else {
            console.error('Failed to add popup: document.body not found');
            return;
        }

        // Add event listeners
        copyBtn.addEventListener('click', () => {
            const url = urlDisplay.textContent;
            if (url) {
                console.log('[IVAC Payment Helper] Copying URL:', url);
                copyToClipboard(url);
                showNotification('Copied to clipboard!');
            }
        });

        closeBtn.addEventListener('click', () => {
            popup.style.display = 'none';
            console.log('[IVAC Payment Helper] Popup closed');
        });

        popup.addEventListener('click', (e) => {
            if (e.target === popup) {
                popup.style.display = 'none';
            }
        });
    }

    function setupRequestInterception() {


        // Intercept XHR requests
        const originalXHROpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function() {
            const xhr = this;
            const originalOnReadyStateChange = xhr.onreadystatechange;

            xhr.addEventListener('load', function() {
                try {
                    if (xhr.responseURL.includes('payment.ivacbd.com/paynow') && xhr.readyState === 4) {
                        const response = JSON.parse(xhr.responseText);
                        if (response?.success && response?.url) {
                            console.log('[IVAC Payment Helper] XHR Intercepted URL:', response.url);
                            showPaymentLink(response.url);
                        }
                    }
                } catch (e) {
                    console.error('[IVAC Payment Helper] XHR interception error:', e);
                }
            });

            originalXHROpen.apply(xhr, arguments);
            if (originalOnReadyStateChange) {
                xhr.onreadystatechange = originalOnReadyStateChange;
            }
        };

        // Intercept fetch requests
        const originalFetch = window.fetch;
        window.fetch = async function() {
            try {
                const response = await originalFetch.apply(this, arguments);
                const requestUrl = arguments[0]?.url || arguments[0];

                if (typeof requestUrl === 'string' && requestUrl.includes('payment.ivacbd.com/paynow')) {
                    const clone = response.clone();
                    const data = await clone.json();
                    if (data?.success && data?.url) {
                        console.log('[IVAC Payment Helper] Fetch Intercepted URL:', data.url);
                        showPaymentLink(data.url);
                    }
                }
                return response;
            } catch (e) {
             /*   console.error('[IVAC Payment Helper] Fetch interception error:', e); */
                return originalFetch.apply(this, arguments);
            }
        };
    }

    function copyToClipboard(text) {
        try {
            if (typeof GM_setClipboard !== 'undefined') {
                GM_setClipboard(text, 'text');
                console.log('[IVAC Payment Helper] URL copied using GM_setClipboard');
                return true;
            } else {
                // Fallback method
                const textarea = document.createElement('textarea');
                textarea.value = text;
                textarea.style.position = 'fixed';
                textarea.style.opacity = 0;
                document.body.appendChild(textarea);
                textarea.select();
                const result = document.execCommand('copy');
                document.body.removeChild(textarea);
                console.log(`[IVAC Payment Helper] URL copied using fallback method (${result ? 'success' : 'failed'})`);
                return result;
            }
        } catch (e) {
            console.error('[IVAC Payment Helper] Copy failed:', e);
            return false;
        }
    }

    function showPaymentLink(url) {
        console.log('[IVAC Payment Helper] Displaying payment link:', url);
        const popup = document.getElementById('paymentLinkPopup');
        const urlDisplay = document.getElementById('paymentUrlDisplay');

        if (!popup || !urlDisplay) {
            console.error('[IVAC Payment Helper] Popup elements not found');
            return;
        }

        urlDisplay.textContent = url;
        popup.style.display = 'flex';

        // Copy to clipboard
        if (copyToClipboard(url)) {
            showNotification('Payment link ready!', 'The URL has been copied to your clipboard');
        } else {
            showNotification('Payment link ready!', 'URL displayed but copy failed');
        }
    }

    function showNotification(title, text) {
        try {
            if (typeof GM_notification !== 'undefined') {
                GM_notification({
                    title: title,
                    text: text || '',
                    timeout: 2000,
                    highlight: true
                });
                console.log(`[IVAC Payment Helper] Notification shown: ${title} - ${text}`);
            } else {
                // Fallback notification
                console.log(`[IVAC Payment Helper] ${title}: ${text}`);
                alert(`${title}\n\n${text}`);
            }
        } catch (e) {
            console.error('[IVAC Payment Helper] Notification failed:', e);
        }
    }

    // Start the script
    init().catch(e => console.error('[IVAC Payment Helper] Initialization error:', e));
})();


//MUlti click =============================================================================================================================================================================
(function() {
    'use strict';

    // ===== CONFIG ===== //
    const CONFIG = {
        defaultClicks: 1,      // Default click count
        maxClicks: 100,         // Maximum allowed clicks
        minDelay: .100,          // Delay between clicks (ms)
        targetButtons: [       // Your specific mother script buttons
            'App Info', 'Per Info', 'Payment',
            'Send OTP', 'Resend', 'Verify',
            'Pay Time', 'Pay Now'
        ]
    };

    // ===== STATE ===== //
    let isProcessing = false;
    let isDragging = false;
    let dragOffset = { x: 0, y: 0 };

    // ===== UI CREATION ===== //
    function createControlPanel() {
        // Check if already exists
        if (document.getElementById('ivac-click-control')) return;

        const container = document.createElement('div');
        container.id = 'ivac-click-control';
        container.style.cssText = `
            position: fixed;
            right: 5px;
            top: 5px;
            z-index: 9999;
            background: #ffff27;
            padding: 8px 35px;
            border-radius: 6px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            border: 1px solid #ddd;
            font-family: 'Inter', sans-serif;
            user-select: none;
            display: flex;
            align-items: center;
            gap: 10px;
        `;

        // Header (draggable area)
        const header = document.createElement('div');
        header.textContent = 'CLICKS:';
        header.style.cssText = `
            font-size: 12px;
            font-weight: bold;
            color: #333;
            cursor: move;
            margin-right: 5px;
        `;
        container.appendChild(header);

        // Click counter input
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.max = CONFIG.maxClicks;
        input.value = CONFIG.defaultClicks;
        input.style.cssText = `
            width: 50px;
            padding: 4px;
            border: 1px solid #ccc;
            border-radius: 4px;
            font-size: 12px;
        `;
        container.appendChild(input);

        // Status indicator
        const status = document.createElement('div');
        status.id = 'ivac-click-status';
        status.style.cssText = `
            font-size: 11px;
            color: #43a047;
            margin-left: 5px;
            min-width: 100px;
        `;
        status.textContent = 'Ready';
        container.appendChild(status);

        // Make draggable
        container.addEventListener('mousedown', (e) => {
            if (e.target !== input && e.button === 0) {
                isDragging = true;
                dragOffset = {
                    x: e.clientX - container.getBoundingClientRect().left,
                    y: e.clientY - container.getBoundingClientRect().top
                };
                e.preventDefault();
            }
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            container.style.left = `${e.clientX - dragOffset.x}px`;
            container.style.top = `${e.clientY - dragOffset.y}px`;
            container.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        document.body.appendChild(container);
    }

    // ===== CLICK HANDLING ===== //
    function getClickCount() {
        const input = document.querySelector('#ivac-click-control input');
        const value = parseInt(input?.value);
        return Math.max(1, Math.min(isNaN(value) ? 1 : value, CONFIG.maxClicks));
    }

    function updateStatus(message, isError = false) {
        const status = document.getElementById('ivac-click-status');
        if (status) {
            status.textContent = message;
            status.style.color = isError ? '#e53935' : '#43a047';
        }
    }

    // ===== MOTHER SCRIPT INTEGRATION ===== //
    function enhanceButtons() {
        // Wait for mother script UI to load
        const motherUI = document.querySelector('#ivac-payment-container');
        if (!motherUI) {
            setTimeout(enhanceButtons, 500);
            return;
        }

        // Find all target buttons
        CONFIG.targetButtons.forEach(btnText => {
            const buttons = Array.from(document.querySelectorAll('button')).filter(
                btn => btn.textContent.trim() === btnText
            );

            buttons.forEach(button => {
                if (button._multiClickEnhanced) return;

                // Store original click handler
                const originalClick = button.onclick;

                button.onclick = async function(e) {
                    if (isProcessing) return;

                    const clickCount = getClickCount();
                    if (clickCount === 1) {
                        return originalClick?.call(this, e);
                    }

                    isProcessing = true;
                    const originalText = button.textContent;

                    try {
                        button.disabled = true;
                        button.style.opacity = '0.7';

                        for (let i = 0; i < clickCount; i++) {
                            updateStatus(`${btnText} (${i+1}/${clickCount})`);

                            // Create fresh event
                            const event = new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            });

                            // Trigger original handler
                            if (originalClick) {
                                originalClick.call(this, event);
                            }

                            // Wait before next click
                            if (i < clickCount - 1) {
                                await new Promise(r => setTimeout(r, CONFIG.minDelay));
                            }
                        }

                        updateStatus(`Sent ${clickCount} clicks`);
                    } catch (error) {
                        updateStatus(`Error: ${error.message}`, true);
                        console.error('Multi-click error:', error);
                    } finally {
                        button.disabled = false;
                        button.style.opacity = '';
                        isProcessing = false;
                    }
                };

                button._multiClickEnhanced = true;
                button.title = `Multi-click enabled (current: ${getClickCount()})`;
            });
        });
    }

    // ===== INITIALIZATION ===== //
    function init() {
        createControlPanel();
        enhanceButtons();

        // Continuous monitoring for new buttons
        setInterval(enhanceButtons, 1000);
    }

    // Start when ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();

//MUlti click =============================================================================================================================================================================

//Audio notification

(function() {
    'use strict';

    // Create an audio context for the beep sound
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Function to play beep sound
    function playBeep() {
        const oscillator = audioContext.createOscillator();
        const gainNode = audioContext.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.type = 'sine';
        oscillator.frequency.value = 800; // Frequency in hertz
        gainNode.gain.value = 0.9; // Volume

        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
        }, 300); // Duration in milliseconds
    }

    // Helper function to check if a message matches our patterns
    function isSuccessMessage(message) {
        if (typeof message === 'string') {
            return message.includes("✅ OTP verified successfully!") ||
                message.includes("✓ Slots load successfully!") ||
                (message.includes("✅ OTP") && message.includes("sent successfully")) ||
                message.includes("🎉 🎉 🎉 Payment URL generated");
        }
        return false;
    }

    // Override console.log to intercept messages
    const originalLog = console.log;
    console.log = function() {
        const args = Array.from(arguments);

        // Check for specific success messages
        if (args.length > 0) {
            // Check first argument (could be string or format string)
            if (isSuccessMessage(args[0])) {
                playBeep();
            }
            // Check for OTP Send Response pattern
       /*     else if (args.length >= 2 &&
                     typeof args[0] === 'string' &&
                     args[0].includes('%cOTP Send Response:')) {
                playBeep();
            } */
            // Check if any argument contains our success message
            else {
                for (const arg of args) {
                    if (isSuccessMessage(arg)) {
                        playBeep();
                        break;
                    }
                }
            }
        }

        // Call original console.log
        originalLog.apply(console, args);
    };

    // Override custom log functions if they exist
    if (typeof logSuccess === 'function') {
        const originalLogSuccess = logSuccess;
        logSuccess = function() {
            const args = Array.from(arguments);

            if (args.length > 0 && isSuccessMessage(args[0])) {
                playBeep();
            }

            originalLogSuccess.apply(this, args);
        };
    }
})();

//audio notification

//Sudiptta Apu 01756443969
