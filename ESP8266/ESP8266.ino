#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <EEPROM.h>
#include <FirebaseESP8266.h>
#include <NTPClient.h>
#include <WiFiUdp.h>

// ======= Web Server =======
ESP8266WebServer server(80);

// EEPROM addresses for storing WiFi credentials
const int ssidAddr = 0;
const int passAddr = 50;
const int maxSsidLen = 32;
const int maxPassLen = 64;

String currentSSID = "";
String currentStatus = "Disconnected";
bool isConnected = false;

// ======= Firebase =======
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;

// ======= CORRECTED PIN DEFINITIONS =======
// ESP8266 NodeMCU pin mapping:
// D1 = GPIO5, D2 = GPIO4, D3 = GPIO0, D4 = GPIO2, 
// D5 = GPIO14, D6 = GPIO12, D7 = GPIO13, D8 = GPIO15

// Sensor pins - using GPIO pins (D1, D5, D6, D7)
const int sensorPins[4] = {D1, D5, D6, D7}; // GPIO5, GPIO14, GPIO12, GPIO13
int sensorValues[4] = {0};       // Raw values (0-1023)
int moistureLevels[4] = {0};     // 0–100% moisture

// Relays for water pumps (D2, D3, D8, D0)
const int relayPins[4] = {D2, D3, D8, D0}; // GPIO4, GPIO0, GPIO15, GPIO16
bool relayStates[4] = {false, false, false, false};  // false = OFF, true = ON

// Timer for Firebase updates
unsigned long lastFirebaseUpdate = 0;
const unsigned long firebaseInterval = 3000; // 3 seconds

// ======= Manual Pump Timer =======
unsigned long manualPumpStartTimes[4] = {0, 0, 0, 0};
const unsigned long manualPumpDuration = 5000; // 5 seconds in milliseconds
bool manualPumpActive[4] = {false, false, false, false};

// ======= NTP Client for Scheduling =======
WiFiUDP ntpUDP;
NTPClient timeClient(ntpUDP, "pool.ntp.org", 19800, 60000); // UTC+5:30 for India

// ======= Auto Mode Structure =======
struct AutoMode {
  bool enabled;
  String lastUpdated;
};

AutoMode autoModes[4] = {
  {false, ""},
  {false, ""},
  {false, ""},
  {false, ""}
};

// ======= Updated Schedule Structure =======
struct Schedule {
  int hour;        // 24-hour format
  int minute;
  int duration;    // in minutes
  bool enabled;
  int daysOfWeek; // bitmask: 0=Sun, 1=Mon, ..., 6=Sat
};

Schedule schedules[4][3] = {
  {{0, 0, 0, false, 0}, {0, 0, 0, false, 0}, {0, 0, 0, false, 0}},
  {{0, 0, 0, false, 0}, {0, 0, 0, false, 0}, {0, 0, 0, false, 0}},
  {{0, 0, 0, false, 0}, {0, 0, 0, false, 0}, {0, 0, 0, false, 0}},
  {{0, 0, 0, false, 0}, {0, 0, 0, false, 0}, {0, 0, 0, false, 0}}
};

unsigned long pumpStartTimes[4] = {0, 0, 0, 0};
int currentPumpDurations[4] = {0, 0, 0, 0};
bool activePumps[4] = {false, false, false, false};

// ======= Function Declarations =======
void connectToWiFi(String ssid, String password);
void disconnectFromWiFi();
void setupAPMode();
String readEEPROM(int startAddr, int maxLen);
void writeEEPROM(int startAddr, String value);
void clearEEPROM();
void sendToFirebase(int sensorValues[], bool pumpStates[]);
void checkSchedules();
void updateSchedulesFromFirebase();
void handleScheduleUpdate();
void togglePump(int pumpIndex, bool state);
void checkPumpCommands();
void initializePumpControlStructure();
void checkManualPumpTimers();
void checkScheduledPumpTimers();
void checkAutoModeStatus();
void initializeAutoModeStructure();

// Web Server Handlers
void handleRoot();
void handleConnect();
void handleDisconnect();
void handleStatus();
void handleScan();
void handleTogglePump();

// ======= Setup =======
void setup() {
  Serial.begin(115200);
  EEPROM.begin(512);
  delay(10);

  // Initialize sensor pins as INPUT
  Serial.println("Initializing sensor pins:");
  for (int i = 0; i < 4; i++) {
    pinMode(sensorPins[i], INPUT);
    Serial.print("Sensor Pin ");
    Serial.print(i);
    Serial.print(": GPIO");
    Serial.println(sensorPins[i]);
  }
  
  // Initialize relay pins as OUTPUT
  Serial.println("Initializing relay pins:");
  for (int i = 0; i < 4; i++) {
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], HIGH); // Relay OFF initially
    Serial.print("Relay Pin ");
    Serial.print(i);
    Serial.print(": GPIO");
    Serial.print(relayPins[i]);
    Serial.println(" - INITIALIZED (HIGH)");
  }

  String storedSSID = readEEPROM(ssidAddr, maxSsidLen);
  String storedPass = readEEPROM(passAddr, maxPassLen);

  if (storedSSID.length() > 0) {
    Serial.println("Found stored WiFi credentials");
    connectToWiFi(storedSSID, storedPass);
  } else {
    Serial.println("No stored WiFi credentials");
    setupAPMode();
  }

  server.on("/", handleRoot);
  server.on("/connect", handleConnect);
  server.on("/disconnect", handleDisconnect);
  server.on("/status", handleStatus);
  server.on("/scan", handleScan);
  server.on("/togglePump", handleTogglePump);
  server.on("/updateSchedule", handleScheduleUpdate);
  server.begin();
  Serial.println("HTTP server started");

  // Firebase config
  config.database_url = "https://aws-data-dd636-default-rtdb.asia-southeast1.firebasedatabase.app";
  config.signer.tokens.legacy_token = "RME2vVhCq8ykGwu2WHABya21tZEFDdDMc3B6v5SA";

  // Initialize Firebase if connected to WiFi
  if (isConnected && WiFi.status() == WL_CONNECTED) {
    timeClient.begin();
    timeClient.setTimeOffset(19800); // UTC+5:30
    
    Firebase.reconnectWiFi(true);
    fbdo.setBSSLBufferSize(1024, 1024);
    fbdo.setResponseSize(1024);
    
    Firebase.begin(&config, &auth);
    Firebase.setDoubleDigits(5);
    
    Serial.println("Firebase initialized successfully");
    
    // Initialize PumpControl and AutoMode structures
    delay(2000);
    initializePumpControlStructure();
    initializeAutoModeStructure();
    
    // LOAD SCHEDULES ON STARTUP
    delay(3000);
    Serial.println("Loading initial schedules from Firebase...");
    updateSchedulesFromFirebase();
  }
}

// ======= Updated Loop =======
void loop() {
  server.handleClient();

  if (WiFi.status() != WL_CONNECTED && isConnected) {
    currentStatus = "Disconnected";
    isConnected = false;
    currentSSID = "";
    Serial.println("WiFi connection lost");
  }

  if (isConnected && WiFi.status() == WL_CONNECTED) {
    unsigned long now = millis();
    
    // Check manual pump timers every loop (HIGHEST PRIORITY - MODE 1)
    checkManualPumpTimers();
    
    // Check scheduled pump timers every loop
    checkScheduledPumpTimers();
    
    if (now - lastFirebaseUpdate > firebaseInterval) {
      lastFirebaseUpdate = now;

      // Read sensors and calculate moisture
      Serial.println("Reading Sensors:");
      for (int i = 0; i < 4; i++) {
        int rawValue = analogRead(sensorPins[i]);
        sensorValues[i] = rawValue;
        moistureLevels[i] = map(rawValue, 1023, 0, 0, 100);

        // Print to Serial
        Serial.print("Sensor ");
        Serial.print(i + 1);
        Serial.print(" (GPIO");
        Serial.print(sensorPins[i]);
        Serial.print("): Raw = ");
        Serial.print(sensorValues[i]);
        Serial.print(" | Moisture = ");
        Serial.print(moistureLevels[i]);
        Serial.println("%");
      }
      Serial.println("-------------------");

      // Check Auto Mode status from Firebase
      checkAutoModeStatus();

      // AUTO MODE (MODE 3): Only control if auto mode is enabled AND not manually controlled AND not scheduled
      for (int i = 0; i < 4; i++) {
        // Check if pump is free for auto mode (auto mode enabled, not manual, and not scheduled)
        bool pumpIsFree = autoModes[i].enabled && !manualPumpActive[i] && !activePumps[i];
        
        if (pumpIsFree) {
          if (moistureLevels[i] < 30 && !relayStates[i]) {
            // Soil is dry - turn pump ON
            togglePump(i, true);
            Serial.print("AUTO MODE: Pump ");
            Serial.print(i + 1);
            Serial.print(" (GPIO");
            Serial.print(relayPins[i]);
            Serial.println(") turned ON - Soil is dry");
          } else if (moistureLevels[i] >= 30 && relayStates[i]) {
            // Soil is wet enough - turn pump OFF
            togglePump(i, false);
            Serial.print("AUTO MODE: Pump ");
            Serial.print(i + 1);
            Serial.print(" (GPIO");
            Serial.print(relayPins[i]);
            Serial.println(") turned OFF - Soil is moist");
          }
        } else {
          // Print mode status
          if (!autoModes[i].enabled) {
            Serial.print("Pump ");
            Serial.print(i + 1);
            Serial.println(" - Auto mode DISABLED");
          } else if (manualPumpActive[i]) {
            Serial.print("Pump ");
            Serial.print(i + 1);
            Serial.println(" is in MANUAL MODE - Auto mode disabled");
          } else if (activePumps[i]) {
            Serial.print("Pump ");
            Serial.print(i + 1);
            Serial.println(" is in SCHEDULE MODE - Auto mode disabled");
          }
        }
      }

      // Send sensor data to Firebase and check for manual commands
      if (Firebase.ready()) {
        sendToFirebase(sensorValues, relayStates);
        checkPumpCommands(); // Check for manual pump commands (MANUAL MODE)
      } else {
        Serial.println("Firebase not ready - skipping update");
      }
    }

    // Check schedules every minute (SCHEDULE MODE - MODE 2)
    static unsigned long lastScheduleCheck = 0;
    if (millis() - lastScheduleCheck > 60000) {
      lastScheduleCheck = millis();
      checkSchedules();
      
      // Update schedules from Firebase every 5 minutes
      static unsigned long lastScheduleUpdate = 0;
      if (millis() - lastScheduleUpdate > 300000) {
        lastScheduleUpdate = millis();
        updateSchedulesFromFirebase();
      }
    }
  } else {
    lastFirebaseUpdate = millis();
  }
}

// ======= Auto Mode Functions =======
void checkAutoModeStatus() {
  if (!Firebase.ready()) {
    return;
  }
  
  for (int i = 0; i < 4; i++) {
    String path = "/AutoMode/Sensor" + String(i + 1) + "/enabled";
    
    if (Firebase.getBool(fbdo, path)) {
      bool newAutoMode = fbdo.boolData();
      
      // Only update if changed
      if (autoModes[i].enabled != newAutoMode) {
        autoModes[i].enabled = newAutoMode;
        Serial.print("Auto Mode for Sensor ");
        Serial.print(i + 1);
        Serial.print(": ");
        Serial.println(newAutoMode ? "ENABLED" : "DISABLED");
      }
    } else {
      Serial.print("Failed to read AutoMode for Sensor");
      Serial.print(i + 1);
      Serial.print(": ");
      Serial.println(fbdo.errorReason());
    }
  }
}

void initializeAutoModeStructure() {
  if (!Firebase.ready()) {
    Serial.println("Firebase not ready - cannot initialize AutoMode");
    return;
  }
  
  Serial.println("Initializing AutoMode structure...");
  
  for (int i = 1; i <= 4; i++) {
    String path = "/AutoMode/Sensor" + String(i) + "/enabled";
    
    // Check if it already exists
    if (Firebase.getBool(fbdo, "/AutoMode/Sensor" + String(i) + "/enabled")) {
      Serial.println("AutoMode/Sensor" + String(i) + " already exists");
    } else {
      // Create it if it doesn't exist
      if (Firebase.setBool(fbdo, path, false)) {
        Serial.println("Created " + path);
      } else {
        Serial.print("Failed to create ");
        Serial.print(path);
        Serial.print(": ");
        Serial.println(fbdo.errorReason());
      }
    }
    delay(100);
  }
}

// ======= Manual Pump Timer Check Function =======
void checkManualPumpTimers() {
  unsigned long currentTime = millis();
  
  for (int i = 0; i < 4; i++) {
    if (manualPumpActive[i]) {
      if (currentTime - manualPumpStartTimes[i] >= manualPumpDuration) {
        // 5 seconds have passed, turn off the pump
        togglePump(i, false);
        manualPumpActive[i] = false;
        Serial.print("MANUAL MODE: Pump ");
        Serial.print(i + 1);
        Serial.print(" (GPIO");
        Serial.print(relayPins[i]);
        Serial.println(") turned off after 5 seconds");
        
        // Update Firebase command status
        if (Firebase.ready()) {
          String commandPath = "/PumpControl/Sensor" + String(i + 1) + "/command";
          Firebase.setString(fbdo, commandPath, "PROCESSED");
        }
      }
    }
  }
}

// ======= Scheduled Pump Timer Check Function =======
void checkScheduledPumpTimers() {
  unsigned long currentTime = millis();
  
  for (int i = 0; i < 4; i++) {
    if (activePumps[i] && !manualPumpActive[i]) { // Only check scheduled pumps, not manual ones
      unsigned long elapsed = (currentTime - pumpStartTimes[i]) / 60000; // minutes
      if (elapsed >= currentPumpDurations[i]) {
        togglePump(i, false);
        activePumps[i] = false;
        Serial.print("SCHEDULE MODE: Pump ");
        Serial.print(i + 1);
        Serial.print(" (GPIO");
        Serial.print(relayPins[i]);
        Serial.print(") turned off after ");
        Serial.print(currentPumpDurations[i]);
        Serial.println(" minutes");
      }
    }
  }
}

// ======= Pump Control Function =======
void togglePump(int pumpIndex, bool state) {
  if (pumpIndex < 0 || pumpIndex >= 4) return;
  
  digitalWrite(relayPins[pumpIndex], state ? LOW : HIGH);
  relayStates[pumpIndex] = state;
  
  if (state) {
    pumpStartTimes[pumpIndex] = millis();
    Serial.print("Pump ");
    Serial.print(pumpIndex + 1);
    Serial.print(" (GPIO");
    Serial.print(relayPins[pumpIndex]);
    Serial.println(") turned ON");
  } else {
    Serial.print("Pump ");
    Serial.print(pumpIndex + 1);
    Serial.print(" (GPIO");
    Serial.print(relayPins[pumpIndex]);
    Serial.println(") turned OFF");
  }
}

// ======= Initialize PumpControl Structure =======
void initializePumpControlStructure() {
  if (!Firebase.ready()) {
    Serial.println("Firebase not ready - cannot initialize PumpControl");
    return;
  }
  
  Serial.println("Initializing PumpControl structure...");
  
  for (int i = 1; i <= 4; i++) {
    String path = "/PumpControl/Sensor" + String(i) + "/command";
    
    // Check if it already exists
    if (Firebase.getString(fbdo, "/PumpControl/Sensor" + String(i) + "/command")) {
      Serial.println("PumpControl/Sensor" + String(i) + " already exists");
    } else {
      // Create it if it doesn't exist
      if (Firebase.setString(fbdo, path, "PROCESSED")) {
        Serial.println("Created " + path);
      } else {
        Serial.print("Failed to create ");
        Serial.print(path);
        Serial.print(": ");
        Serial.println(fbdo.errorReason());
      }
    }
    delay(100);
  }
}

// ======= UPDATED: Firebase Pump Command Check =======
void checkPumpCommands() {
  if (!Firebase.ready()) {
    return;
  }
  
  for (int i = 0; i < 4; i++) {
    String sensorPath = "/PumpControl/Sensor" + String(i + 1);
    String commandPath = sensorPath + "/command";
    
    // Check if PumpControl structure exists
    if (!Firebase.pathExist(fbdo, sensorPath)) {
      Serial.println("PumpControl structure missing, creating...");
      initializePumpControlStructure();
      continue;
    }
    
    // Now check for commands
    if (Firebase.getString(fbdo, commandPath)) {
      String command = fbdo.stringData();
      
      if (command == "ON" && !manualPumpActive[i] && !relayStates[i]) {
        // MANUAL MODE (MODE 1): Start manual pump for 5 seconds
        togglePump(i, true);
        manualPumpActive[i] = true;
        manualPumpStartTimes[i] = millis();
        
        Serial.print("MANUAL MODE: Pump ");
        Serial.print(i + 1);
        Serial.print(" (GPIO");
        Serial.print(relayPins[i]);
        Serial.println(") turned ON for 5 seconds via Firebase");
        Firebase.setString(fbdo, commandPath, "PROCESSED");
        
      } else if (command == "OFF" && relayStates[i]) {
        // Force turn off pump (can stop any mode)
        togglePump(i, false);
        manualPumpActive[i] = false;
        activePumps[i] = false;
        
        Serial.print("MANUAL OVERRIDE: Pump ");
        Serial.print(i + 1);
        Serial.print(" (GPIO");
        Serial.print(relayPins[i]);
        Serial.println(") turned OFF via Firebase");
        Firebase.setString(fbdo, commandPath, "PROCESSED");
      }
    } else {
      Serial.print("Failed to read command for Sensor");
      Serial.print(i + 1);
      Serial.print(": ");
      Serial.println(fbdo.errorReason());
    }
  }
}

// ======= Updated Schedule Functions =======
void checkSchedules() {
  if (!isConnected || WiFi.status() != WL_CONNECTED) {
    return;
  }
  
  timeClient.update();
  int currentHour = timeClient.getHours();
  int currentMinute = timeClient.getMinutes();
  int currentDay = timeClient.getDay(); // 0=Sunday, 6=Saturday

  Serial.print("=== CHECKING SCHEDULES - Current time: ");
  Serial.print(currentHour);
  Serial.print(":");
  Serial.print(currentMinute);
  Serial.print(" Day: ");
  Serial.print(currentDay);
  Serial.println(" ===");

  // Check all schedules
  for (int sensor = 0; sensor < 4; sensor++) {
    // Skip if pump is already active for this sensor (manual or scheduled)
    if (manualPumpActive[sensor] || activePumps[sensor]) {
      Serial.print("Skipping Sensor ");
      Serial.print(sensor + 1);
      Serial.println(" - Pump already active");
      continue;
    }
    
    for (int i = 0; i < 3; i++) {
      Schedule sched = schedules[sensor][i];
      
      Serial.print("Sensor ");
      Serial.print(sensor + 1);
      Serial.print(" Schedule ");
      Serial.print(i + 1);
      Serial.print(": ");
      Serial.print(sched.enabled ? "ENABLED " : "DISABLED ");
      Serial.print(sched.hour);
      Serial.print(":");
      Serial.print(sched.minute);
      Serial.print(" Dur:");
      Serial.print(sched.duration);
      Serial.print(" Days:");
      Serial.print(sched.daysOfWeek);
      Serial.print(" CurrentDayBit:");
      Serial.print(1 << currentDay);
      Serial.print(" Match:");
      Serial.println((sched.daysOfWeek & (1 << currentDay)) ? "YES" : "NO");
      
      if (sched.enabled && 
          (sched.daysOfWeek & (1 << currentDay)) &&
          sched.hour == currentHour &&
          sched.minute == currentMinute) {
        
        togglePump(sensor, true);
        currentPumpDurations[sensor] = sched.duration;
        activePumps[sensor] = true;
        
        Serial.print("🎯 SCHEDULE TRIGGERED: Pump ");
        Serial.print(sensor + 1);
        Serial.print(" (GPIO");
        Serial.print(relayPins[sensor]);
        Serial.print(") turned ON by schedule at ");
        Serial.print(sched.hour);
        Serial.print(":");
        Serial.print(sched.minute);
        Serial.print(" for ");
        Serial.print(sched.duration);
        Serial.println(" minutes");
        break;
      }
    }
  }
}

void updateSchedulesFromFirebase() {
  if (!Firebase.ready()) {
    Serial.println("Firebase not ready - cannot update schedules");
    return;
  }
  
  Serial.println("=== UPDATING SCHEDULES FROM FIREBASE ===");
  
  for (int sensor = 0; sensor < 4; sensor++) {
    String path = "/Schedules/Sensor" + String(sensor + 1);
    
    Serial.print("Checking path: ");
    Serial.println(path);
    
    if (Firebase.getJSON(fbdo, path)) {
      FirebaseJson json;
      FirebaseJsonData result;
      json.setJsonData(fbdo.jsonString());
      
      Serial.print("Raw JSON for Sensor");
      Serial.print(sensor + 1);
      Serial.print(": ");
      Serial.println(fbdo.jsonString());
      
      for (int i = 0; i < 3; i++) {
        String schedulePath = "/schedule" + String(i + 1);
        
        // Get enabled status
        if (json.get(result, schedulePath + "/enabled")) {
          schedules[sensor][i].enabled = result.boolValue;
          Serial.print("Schedule ");
          Serial.print(i + 1);
          Serial.print(" enabled: ");
          Serial.println(schedules[sensor][i].enabled);
        } else {
          schedules[sensor][i].enabled = false;
        }
        
        // Get hour (24-hour format)
        if (json.get(result, schedulePath + "/hour24")) {
          schedules[sensor][i].hour = result.intValue;
          Serial.print("Schedule ");
          Serial.print(i + 1);
          Serial.print(" hour24: ");
          Serial.println(schedules[sensor][i].hour);
        } else {
          schedules[sensor][i].hour = 0;
        }
        
        // Get minute
        if (json.get(result, schedulePath + "/minute")) {
          schedules[sensor][i].minute = result.intValue;
          Serial.print("Schedule ");
          Serial.print(i + 1);
          Serial.print(" minute: ");
          Serial.println(schedules[sensor][i].minute);
        } else {
          schedules[sensor][i].minute = 0;
        }
        
        // Get duration
        if (json.get(result, schedulePath + "/duration")) {
          schedules[sensor][i].duration = result.intValue;
          Serial.print("Schedule ");
          Serial.print(i + 1);
          Serial.print(" duration: ");
          Serial.println(schedules[sensor][i].duration);
        } else {
          schedules[sensor][i].duration = 0;
        }
        
        // Get days
        if (json.get(result, schedulePath + "/days")) {
          schedules[sensor][i].daysOfWeek = result.intValue;
          Serial.print("Schedule ");
          Serial.print(i + 1);
          Serial.print(" days: ");
          Serial.println(schedules[sensor][i].daysOfWeek);
        } else {
          schedules[sensor][i].daysOfWeek = 0;
        }
      }
      
      Serial.print("=== UPDATED SCHEDULES FOR SENSOR");
      Serial.print(sensor + 1);
      Serial.println(" ===");
      
    } else {
      Serial.print("FAILED to get schedules for Sensor");
      Serial.print(sensor + 1);
      Serial.print(": ");
      Serial.println(fbdo.errorReason());
      
      // Initialize with default values if no data exists
      for (int i = 0; i < 3; i++) {
        schedules[sensor][i] = {0, 0, 0, false, 0};
      }
    }
  }
  
  Serial.println("=== SCHEDULE UPDATE COMPLETE ===");
}

void handleScheduleUpdate() {
  if (server.method() != HTTP_POST) {
    server.send(405, "text/plain", "Method Not Allowed");
    return;
  }
  
  if (server.hasArg("plain")) {
    String data = server.arg("plain");
    // Parse JSON and update schedules
    server.send(200, "application/json", "{\"status\":\"success\"}");
  }
}

// ======= Send RAW SENSOR VALUES (0-1023) to Firebase =======
void sendToFirebase(int sensorValues[], bool pumpStates[]) {
  // Check if Firebase is initialized and connected
  if (!Firebase.ready()) {
    Serial.println("Firebase not ready - skipping update");
    return;
  }
  
  // Send each RAW SENSOR VALUE (0-1023) to its own path
  for (int i = 0; i < 4; i++) {
    String path = "/Sensor" + String(i + 1);
    if (Firebase.setInt(fbdo, path, sensorValues[i])) {
      Serial.println("Sensor" + String(i + 1) + " raw value sent to Firebase: " + String(sensorValues[i]) + " (0-1023)");
    } else {
      Serial.print("Firebase Error for Sensor" + String(i + 1) + ": ");
      Serial.println(fbdo.errorReason());
      
      // Check if it's an authentication error
      if (fbdo.errorReason().indexOf("auth") != -1) {
        Serial.println("Authentication error - check your Firebase token");
      }
    }
    delay(50); // Small delay between updates
  }

  // Send pump states
  for (int i = 0; i < 4; i++) {
    String path = "/PumpState" + String(i + 1);
    if (Firebase.setString(fbdo, path, pumpStates[i] ? "ON" : "OFF")) {
      Serial.println("PumpState" + String(i + 1) + " sent to Firebase: " + String(pumpStates[i] ? "ON" : "OFF"));
    } else {
      Serial.print("Firebase Error for PumpState" + String(i + 1) + ": ");
      Serial.println(fbdo.errorReason());
    }
    delay(50);
  }
}

// ======= WiFi Functions =======
void connectToWiFi(String ssid, String password) {
  Serial.println("Connecting to: " + ssid);
  WiFi.begin(ssid.c_str(), password.c_str());

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 20) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected to WiFi!");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());

    currentStatus = "Connected to " + ssid;
    isConnected = true;
    currentSSID = ssid;

    writeEEPROM(ssidAddr, ssid);
    writeEEPROM(passAddr, password);
    EEPROM.commit();

    // Initialize Firebase properly with both config and auth
    Firebase.reconnectWiFi(true);
    fbdo.setBSSLBufferSize(1024, 1024);
    fbdo.setResponseSize(1024);
    
    Firebase.begin(&config, &auth);
    Firebase.setDoubleDigits(5);
    
    Serial.println("Firebase initialized successfully");
    
    // Initialize PumpControl and AutoMode structures
    delay(2000);
    initializePumpControlStructure();
    initializeAutoModeStructure();
    
    // Initialize NTP client
    timeClient.begin();
    timeClient.setTimeOffset(19800); // UTC+5:30
    
    // Load schedules on first connection
    delay(3000);
    updateSchedulesFromFirebase();
    
    lastFirebaseUpdate = millis();
  } else {
    Serial.println("\nFailed to connect to WiFi");
    currentStatus = "Failed to connect to " + ssid;
    isConnected = false;
    currentSSID = "";
    setupAPMode();
  }
}

void disconnectFromWiFi() {
  WiFi.disconnect();
  delay(1000);
  currentStatus = "Disconnected";
  isConnected = false;
  currentSSID = "";
  clearEEPROM();
  setupAPMode();
  lastFirebaseUpdate = millis();
}

void setupAPMode() {
  Serial.println("Setting up AP mode");
  String apName = "ESP8266-" + String(ESP.getChipId());
  WiFi.mode(WIFI_AP);
  WiFi.softAP(apName.c_str());
  Serial.print("AP IP address: ");
  Serial.println(WiFi.softAPIP());
  currentStatus = "AP Mode: " + apName;
  lastFirebaseUpdate = millis();
}

// ======= EEPROM Functions =======
String readEEPROM(int startAddr, int maxLen) {
  String value = "";
  for (int i = 0; i < maxLen; ++i) {
    char c = EEPROM.read(startAddr + i);
    if (c == 0) break;
    value += c;
  }
  return value;
}

void writeEEPROM(int startAddr, String value) {
  for (int i = 0; i < value.length(); ++i) {
    EEPROM.write(startAddr + i, value[i]);
  }
  EEPROM.write(startAddr + value.length(), 0);
}

void clearEEPROM() {
  for (int i = 0; i < 512; ++i) {
    EEPROM.write(i, 0);
  }
  EEPROM.commit();
}

// ======= Web Handlers =======
void handleRoot() {
  String html = "<!DOCTYPE html><html><head>";
  html += "<meta name='viewport' content='width=device-width, initial-scale=1'>";
  html += "<title>ESP8266 Soil Moisture Sensor</title>";
  html += "<style>body { font-family: Arial; margin: 20px; }";
  html += "table { border-collapse: collapse; width: 100%; }";
  html += "th, td { border: 1px solid #ddd; padding: 8px; text-align: center; }";
  html += "th { background-color: #f2f2f2; }";
  html += ".low-moisture { background-color: #ffcccc; }";
  html += ".good-moisture { background-color: #ccffcc; }";
  html += "</style></head><body>";
  html += "<h1>Soil Moisture Sensor</h1>";
  html += "<p>Status: <b>" + currentStatus + "</b></p>";

  if (isConnected) {
    html += "<p>IP Address: " + WiFi.localIP().toString() + "</p>";
    html += "<h3>Sensor Readings:</h3>";
    html += "<table><tr><th>Sensor</th><th>Raw Value (0-1023)</th><th>Moisture %</th><th>Pump Status</th><th>Auto Mode</th><th>Action</th></tr>";
    for (int i = 0; i < 4; i++) {
      String rowClass = moistureLevels[i] < 30 ? "low-moisture" : "good-moisture";
      html += "<tr class='" + rowClass + "'>";
      html += "<td>Sensor " + String(i + 1) + "</td>";
      html += "<td><b>" + String(sensorValues[i]) + "</b></td>";
      html += "<td>" + String(moistureLevels[i]) + "%</td>";
      html += "<td><b>" + String(relayStates[i] ? "ON" : "OFF") + "</b></td>";
      html += "<td><b>" + String(autoModes[i].enabled ? "ENABLED" : "DISABLED") + "</b></td>";
      html += "<td><button onclick=\"location.href='/togglePump?pump=" + String(i) + "'\">Toggle Pump " + String(i + 1) + "</button></td>";
      html += "</tr>";
    }
    html += "</table>";
    html += "<p><small>Note: Moisture levels below 30% will trigger automatic watering (if Auto Mode enabled)</small></p>";
    html += "<p><small>Firebase receives: <b>Raw Values (0-1023)</b></small></p>";
    html += "<p><small><b>Three Modes: 1) Manual (5s), 2) Schedule, 3) Auto (Dry/Wet)</b></small></p>";
    html += "<br><button onclick=\"location.href='/disconnect'\">Disconnect WiFi</button>";
  }

  html += "<h3>Connect to WiFi:</h3>";
  html += "<form action='/connect' method='POST'>";
  html += "<input type='text' name='ssid' placeholder='WiFi SSID' required><br>";
  html += "<input type='password' name='password' placeholder='WiFi Password'><br>";
  html += "<button type='submit'>Connect</button>";
  html += "</form>";
  html += "<a href='/scan'>Scan Available Networks</a>";
  html += "</body></html>";
  server.send(200, "text/html", html);
}

void handleConnect() {
  if (server.method() != HTTP_POST) {
    server.send(405, "text/plain", "Method Not Allowed");
    return;
  }
  String ssid = server.arg("ssid");
  String password = server.arg("password");
  if (ssid.length() == 0) {
    server.send(400, "text/plain", "SSID cannot be empty");
    return;
  }
  connectToWiFi(ssid, password);
  server.sendHeader("Location", "/");
  server.send(303);
}

void handleDisconnect() {
  disconnectFromWiFi();
  server.sendHeader("Location", "/");
  server.send(303);
}

void handleStatus() {
  String json = "{";
  json += "\"connected\": " + String(isConnected ? "true" : "false") + ",";
  json += "\"ssid\": \"" + currentSSID + "\",";
  json += "\"status\": \"" + currentStatus + "\",";
  json += "\"sensor_values\": [";
  for (int i = 0; i < 4; i++) {
    json += String(sensorValues[i]);
    if (i < 3) json += ",";
  }
  json += "],";
  json += "\"moisture_levels\": [";
  for (int i = 0; i < 4; i++) {
    json += String(moistureLevels[i]);
    if (i < 3) json += ",";
  }
  json += "],";
  json += "\"pump_states\": [";
  for (int i = 0; i < 4; i++) {
    json += String(relayStates[i] ? "true" : "false");
    if (i < 3) json += ",";
  }
  json += "],";
  json += "\"auto_modes\": [";
  for (int i = 0; i < 4; i++) {
    json += String(autoModes[i].enabled ? "true" : "false");
    if (i < 3) json += ",";
  }
  json += "],";
  json += "\"manual_pump_active\": [";
  for (int i = 0; i < 4; i++) {
    json += String(manualPumpActive[i] ? "true" : "false");
    if (i < 3) json += ",";
  }
  json += "],";
  json += "\"active_pumps\": [";
  for (int i = 0; i < 4; i++) {
    json += String(activePumps[i] ? "true" : "false");
    if (i < 3) json += ",";
  }
  json += "],";
  json += "\"ip\": \"" + (isConnected ? WiFi.localIP().toString() : "") + "\"";
  json += "}";
  server.send(200, "application/json", json);
}

void handleScan() {
  String html = "<!DOCTYPE html><html><body><h1>Available WiFi Networks</h1><ul>";
  int n = WiFi.scanNetworks();
  if (n == 0) {
    html += "<li>No networks found</li>";
  } else {
    for (int i = 0; i < n; ++i) {
      html += "<li>" + WiFi.SSID(i) + " (" + String(WiFi.RSSI(i)) + " dBm)</li>";
    }
  }
  html += "</ul><a href='/'>Back to Main</a></body></html>";
  server.send(200, "text/html", html);
}

void handleTogglePump() {
  int pumpIndex = 0;
  if (server.hasArg("pump")) {
    pumpIndex = server.arg("pump").toInt();
  }
  
  if (pumpIndex >= 0 && pumpIndex < 4) {
    if (!relayStates[pumpIndex]) {
      // Turn pump on for 5 seconds
      togglePump(pumpIndex, true);
      manualPumpActive[pumpIndex] = true;
      manualPumpStartTimes[pumpIndex] = millis();
      Serial.print("MANUAL MODE: Pump ");
      Serial.print(pumpIndex + 1);
      Serial.print(" (GPIO");
      Serial.print(relayPins[pumpIndex]);
      Serial.println(") turned ON for 5 seconds via web");
    } else {
      // Force turn off
      togglePump(pumpIndex, false);
      manualPumpActive[pumpIndex] = false;
      activePumps[pumpIndex] = false;
      Serial.print("MANUAL OVERRIDE: Pump ");
      Serial.print(pumpIndex + 1);
      Serial.print(" (GPIO");
      Serial.print(relayPins[pumpIndex]);
      Serial.println(") turned OFF manually via web");
    }
  }
  
  server.sendHeader("Location", "/");
  server.send(303);
}