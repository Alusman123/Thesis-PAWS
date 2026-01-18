// App.js
import React, { useEffect, useState } from "react";
import { NavigationContainer } from "@react-navigation/native";
import { createStackNavigator } from "@react-navigation/stack";
import { ref, onValue, update, get } from "firebase/database";
import { Picker } from '@react-native-picker/picker';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Modal,
  TextInput,
  Alert,
  Linking,
  ScrollView,
  FlatList,
  Switch,  
  Animated,
  Platform
} from "react-native";
import { db, auth, sendOTP, verifyOTP, deleteUserAccount } from "./firebaseConfig";
import { signOut, onAuthStateChanged } from "firebase/auth";
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';

const ALLOWED_IP = "192.168.4.1";
const Stack = createStackNavigator();

// Configure notifications
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

// Request notification permissions
const requestNotificationPermissions = async () => {
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
};

// Schedule a local notification
const scheduleMoistureNotification = async (title, body, data = {}) => {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      data,
      sound: 'default',
    },
    trigger: null, // Send immediately
  });
};

// Soil moisture notification manager
class MoistureNotificationManager {
  constructor() {
    this.previousMoistureValues = [null, null, null, null];
    this.notificationCooldown = 300000; // 5 minutes cooldown between same sensor notifications
    this.lastNotificationTime = [0, 0, 0, 0];
  }

  // Check for significant moisture changes and send notifications
  checkMoistureChange(sensorIndex, currentValue, plantName) {
    const previousValue = this.previousMoistureValues[sensorIndex];
    const now = Date.now();
    
    // Skip if no previous value or same value
    if (previousValue === null || currentValue === previousValue) {
      this.previousMoistureValues[sensorIndex] = currentValue;
      return;
    }

    // Calculate change percentage
    const change = Math.abs(currentValue - previousValue);
    const changePercentage = (change / 1023) * 100;

    // Only notify for significant changes (more than 10%)
    if (changePercentage >= 10) {
      // Check cooldown
      if (now - this.lastNotificationTime[sensorIndex] > this.notificationCooldown) {
        this.sendMoistureNotification(sensorIndex, currentValue, previousValue, plantName);
        this.lastNotificationTime[sensorIndex] = now;
      }
    }

    this.previousMoistureValues[sensorIndex] = currentValue;
  }

  async sendMoistureNotification(sensorIndex, currentValue, previousValue, plantName) {
    const status = this.getMoistureStatus(currentValue);
    const previousStatus = this.getMoistureStatus(previousValue);
    
    let title = `🌱 ${plantName} Moisture Change`;
    let body = `Changed from ${previousStatus} to ${status} (${currentValue}/1023)`;
    
    // Custom messages based on status changes
    if (status === "Dry" && previousStatus !== "Dry") {
      body = `🚨 ${plantName} needs water! Soil is now Dry (${currentValue}/1023)`;
    } else if (status === "Wet" && previousStatus !== "Wet") {
      body = `💧 ${plantName} is well watered! Soil is now Wet (${currentValue}/1023)`;
    } else if (status === "Moist" && previousStatus === "Dry") {
      body = `✅ ${plantName} moisture improved! Now Moist (${currentValue}/1023)`;
    }

    await scheduleMoistureNotification(title, body, {
      sensorIndex,
      plantName,
      moistureValue: currentValue,
      status
    });
  }

  getMoistureStatus(value) {
    if (value === null) return "No data";
    if (value >= 800) return "Dry";
    if (value >= 400) return "Moist";
    return "Wet";
  }

  // Check for critical moisture levels
  checkCriticalMoisture(sensorIndex, currentValue, plantName) {
    if (currentValue === null) return;

    const now = Date.now();
    const status = this.getMoistureStatus(currentValue);
    
    // Critical dry level - send immediate notification
    if (status === "Dry" && now - this.lastNotificationTime[sensorIndex] > this.notificationCooldown) {
      this.sendCriticalNotification(sensorIndex, currentValue, plantName, "dry");
      this.lastNotificationTime[sensorIndex] = now;
    }
  }

  async sendCriticalNotification(sensorIndex, currentValue, plantName, type) {
    let title, body;
    
    if (type === "dry") {
      title = "🚨 Plant Needs Immediate Attention!";
      body = `${plantName} is very dry (${currentValue}/1023). Consider watering soon.`;
    }

    await scheduleMoistureNotification(title, body, {
      sensorIndex,
      plantName,
      moistureValue: currentValue,
      critical: true,
      type
    });
  }
}

// Create global instance
const moistureNotifier = new MoistureNotificationManager();

// Updated handleLogout function with account deletion option
const handleLogout = async (navigation) => {
  try {
    Alert.alert(
      "Logout",
      "Are you sure you want to Logout?",
      [
        {
          text: "Cancel",
          style: "cancel"
        },
        {
          text: "Logout & Remove Account",
          onPress: async () => {
            try {
              // Show loading indicator
              Alert.alert("Please wait", "Removing your account and data...");
              
              // Delete the user account and data
              const result = await deleteUserAccount();
              
              if (result.success) {
                Alert.alert("Success", "Account removed successfully");
              } else {
                // If account deletion fails, provide specific feedback
                console.log('Account deletion result:', result);
                
                if (result.error.includes('requires-recent-login')) {
                  Alert.alert(
                    "Security Check Required",
                    "For security reasons, we've removed all your data but couldn't delete the account immediately. Please login again if you want to completely remove your account.",
                    [{ text: "OK" }]
                  );
                } else {
                  Alert.alert(
                    "Account Partially Removed", 
                    "We've removed all your data from the system. " + (result.error || "Your account has been signed out."),
                    [{ text: "OK" }]
                  );
                }
              }
            } catch (error) {
              console.error('Logout error:', error);
              // Fallback to regular sign out
              await signOut(auth);
              Alert.alert("Signed Out", "You have been signed out successfully.");
            }
          },
          style: "destructive"
        }
      ]
    );
  } catch (error) {
    console.error('Logout error:', error);
    // Final fallback - always ensure user is signed out
    await signOut(auth);
  }
};

// Utility functions
const generateDeviceId = () => {
  return `Device_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
};

const generateAccessToken = () => {
  return Math.random().toString(36).substr(2) + Math.random().toString(36).substr(2);
};

const getDeviceCountForIPAndUser = (devices, ipAddress, userId) => {
  return Object.values(devices).filter(
    device => device.ip === ipAddress && device.userId === userId
  ).length;
};

const controlPump = async (sensorId, action) => {
  try {
    const pumpPath = `/PumpControl/Sensor${sensorId + 1}`;
    await update(ref(db, pumpPath), {
      command: action,
      timestamp: new Date().toISOString(),
      sensorId: sensorId + 1
    });
    
    console.log(`Pump ${sensorId + 1} ${action} command sent`);
    return true;
  } catch (error) {
    console.error("Error controlling pump:", error);
    return false;
  }
};

const loadSchedules = async (sensorId, userId) => {
  // ADDED: User validation
  if (!userId) {
    console.error("No user ID provided for loading schedules");
    return getDefaultSchedules();
  }

  try {
    const scheduleRef = ref(db, `Schedules/${userId}/Sensor${sensorId + 1}`);
    const snapshot = await get(scheduleRef);
    
    if (snapshot.exists()) {
      const data = snapshot.val();
      console.log("Loaded schedules for user", userId, ":", data);
      
      if (Array.isArray(data)) {
        return data;
      } else if (data.schedules && Array.isArray(data.schedules)) {
        return data.schedules;
      } else {
        const schedules = [];
        for (let i = 1; i <= 3; i++) {
          const scheduleKey = `schedule${i}`;
          if (data[scheduleKey]) {
            schedules.push({
              hour: data[scheduleKey].hour || 8 + (i-1)*6,
              minute: data[scheduleKey].minute || 0,
              enabled: data[scheduleKey].enabled || false,
              days: data[scheduleKey].days || 127
            });
          }
        }
        return schedules.length > 0 ? schedules : getDefaultSchedules();
      }
    }
  } catch (error) {
    console.error("Error loading schedules for user", userId, ":", error);
  }
  
  return getDefaultSchedules();
};

const getDefaultSchedules = () => [
  { hour: 8, minute: 0, enabled: false, days: 127 },
  { hour: 14, minute: 0, enabled: false, days: 127 },
  { hour: 20, minute: 0, enabled: false, days: 127 }
];

// Decorative Components
const LeafDecoration = ({ style, rotation }) => (
  <View style={[styles.leaf, style, { transform: [{ rotate: rotation }] }]}>
    <Text style={styles.leafText}>🍃</Text>
  </View>
);

const SmallLeaf = ({ style, rotation }) => (
  <View style={[styles.smallLeaf, style, { transform: [{ rotate: rotation }] }]}>
    <Text style={styles.smallLeafText}>🍃</Text>
  </View>
);

// Authentication Screens
const LoginScreen = ({ navigation }) => {
  const [email, setEmail] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isRegisterLoading, setIsRegisterLoading] = useState(false);
  const [otpModalVisible, setOtpModalVisible] = useState(false);
  const [tempEmail, setTempEmail] = useState("");
  const [otpPurpose, setOtpPurpose] = useState(""); // "register" or "login"

  const handleSendOTP = async (purpose) => {
    if (!email || !email.includes('@')) {
      Alert.alert("Error", "Please enter a valid email address");
      return;
    }

    // Set loading state based on purpose
    if (purpose === 'register') {
      setIsRegisterLoading(true);
    } else {
      setIsLoading(true);
    }
    
    setOtpPurpose(purpose);

    try {
      console.log('Sending OTP for:', email, 'Purpose:', purpose);
      const result = await sendOTP(email, purpose);
      
      console.log('OTP Send Result:', result);
      
      if (result.success) {
        setTempEmail(email);
        setOtpModalVisible(true);
        // REMOVED ONLY THIS ALERT LINE:
        // Alert.alert("OTP Sent", `Check your email for the verification code${result.demoOTP ? `\n\nDemo OTP: ${result.demoOTP}` : ''}`);
      } else {
        Alert.alert("OTP Failed", result.error || "Failed to send OTP");
      }
    } catch (error) {
      console.error('OTP Send Error:', error);
      Alert.alert("Error", "Failed to send OTP: " + error.message);
    } finally {
      // Clear loading states
      setIsRegisterLoading(false);
      setIsLoading(false);
    }
  };

  const handleVerifyOTP = async (otp) => {
    try {
      console.log('Verifying OTP for:', tempEmail, 'Purpose:', otpPurpose);
      const result = await verifyOTP(tempEmail, otp, otpPurpose);
      console.log('OTP Verification Result:', result);
      
      if (result.success) {
        setOtpModalVisible(false);
        const message = otpPurpose === 'register' 
          ? "Account created successfully! Welcome to PAWS!" 
          : "Welcome back to PAWS!";
        Alert.alert("Success", message);
      } else {
        Alert.alert("OTP Error", result.error || "Invalid OTP");
      }
    } catch (error) {
      console.error('OTP Verification Error:', error);
      Alert.alert("Authentication Error", error.message);
    }
  };

  const handleResendOTP = async () => {
    const result = await sendOTP(tempEmail, otpPurpose);
    if (result.success) {
      Alert.alert("OTP Resent", "New OTP sent to your email");
      return result;
    } else {
      Alert.alert("Resend Failed", result.error || "Failed to resend OTP");
      return result;
    }
  };

  return (
    <View style={[styles.container, styles.welcomeBg]}>
      <LeafDecoration style={{ top: 100, left: 30 }} rotation="-30deg" />
      <LeafDecoration style={{ top: 150, right: 40 }} rotation="50deg" />
      <SmallLeaf style={{ bottom: 120, left: 50 }} rotation="10deg" />
      <SmallLeaf style={{ bottom: 180, right: 60 }} rotation="-70deg" />

      {/* UPDATED: Added frame container */}
      <View style={styles.loginFrame}>
        <Text style={styles.title}>Welcome to PAWS</Text>
        <Text style={styles.subtitle}>Plant Automation Watering System</Text>

        <View style={styles.authContainer}>
          <TextInput
            style={styles.input}
            placeholder="Enter your email address"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
          />

          <View style={styles.otpButtonsContainer}>
            <TouchableOpacity 
              style={[
                styles.otpButton, 
                styles.registerButton,
                (isRegisterLoading || isLoading) && styles.disabledButton
              ]} 
              onPress={() => handleSendOTP('register')}
              disabled={isRegisterLoading || isLoading}
            >
              <Text style={styles.registerButtonText}>
                {isRegisterLoading ? "Sending OTP..." : "Register with OTP"}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.otpAlternative}>
            🔐 Secure OTP authentication - No password required
          </Text>
        </View>
      </View>

      <OTPModal
        visible={otpModalVisible}
        onClose={() => {
          setOtpModalVisible(false);
        }}
        email={tempEmail}
        purpose={otpPurpose}
        onVerify={handleVerifyOTP}
        onResend={handleResendOTP}
      />
    </View>
  );
};

// Modal Components
const DeviceRenameModal = ({ visible, onClose, onRename, currentName }) => {
  const [name, setName] = useState("");

  useEffect(() => {
    if (visible) {
      setName(currentName || "");
    }
  }, [currentName, visible]);

  const handleApply = () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter a device name");
      return;
    }
    onRename(name.trim());
  };

  return (
    <Modal animationType="fade" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Rename Device</Text>
          <TextInput 
            style={styles.input} 
            value={name} 
            onChangeText={setName} 
            placeholder="Enter device name" 
            autoFocus={true}
            autoCapitalize="words"
            autoCorrect={false}
          />
          <View style={styles.modalButtons}>
            <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={onClose}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalButton, styles.connectButton]} onPress={handleApply}>
              <Text style={styles.connectButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const PlantRegistrationModal = ({ visible, onClose, onRegister, sensorId }) => {
  const [plantName, setPlantName] = useState("");

  useEffect(() => {
    if (!visible) setPlantName("");
  }, [visible]);

  const handleRegister = () => {
    if (!plantName.trim()) {
      Alert.alert("Error", "Please enter a plant name");
      return;
    }
    onRegister(sensorId, plantName.trim());
    setPlantName("");
    onClose();
  };

  // Check if this is Sensor 3 (index 2)
  const isSensor3 = sensorId === 2;

  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Register Plant</Text>
          <Text style={styles.modalSubtitle}>
            {isSensor3 
              ? "Exclusive for Dry Plants - Connected to water pump"
              : `Enter a name for your plant connected to sensor ${sensorId + 1}`
            }
          </Text>

          <TextInput
            style={styles.input}
            placeholder="e.g., Rose, Basil, Cactus"
            value={plantName}
            onChangeText={setPlantName}
            autoCapitalize="words"
            autoCorrect={false}
          />

          {isSensor3 && (
            <Text style={styles.sensor3Warning}>
              ⚠️ This sensor is optimized for dry plants and directly controls the water pump
            </Text>
          )}

          <View style={styles.modalButtons}>
            <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={onClose}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalButton, styles.connectButton]} onPress={handleRegister}>
              <Text style={styles.connectButtonText}>
                {isSensor3 ? "Activate" : "Register"}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

// Updated OTPModal with fixed UI
const OTPModal = ({ visible, onClose, email, purpose, onVerify, onResend }) => {
  const [otp, setOtp] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (visible) {
      setOtp('');
      setIsLoading(false);
      setResendLoading(false);
      startCountdown();
    }
  }, [visible]);

  const startCountdown = () => {
    setCountdown(30);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleVerify = async () => {
    if (!otp.trim() || otp.length !== 6) {
      Alert.alert('Error', 'Please enter a valid 6-digit OTP code');
      return;
    }

    setIsLoading(true);
    try {
      await onVerify(otp);
    } catch (error) {
      Alert.alert('Error', 'Failed to verify OTP');
    } finally {
      setIsLoading(false);
    }
  };

  const handleResend = async () => {
    setResendLoading(true);
    try {
      await onResend();
      startCountdown();
    } catch (error) {
      Alert.alert('Error', 'Failed to resend OTP');
    } finally {
      setResendLoading(false);
    }
  };

  const getPurposeText = () => {
    return purpose === 'register' ? 'Create Account' : 'Login';
  };

  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.otpModalContainer}>
        <View style={styles.otpModalContent}>
          <View style={styles.otpHeader}>
            <Text style={styles.otpTitle}>Verify Your Email</Text>
            <TouchableOpacity onPress={onClose} style={styles.otpCloseButton}>
              <Text style={styles.otpCloseButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.otpSubtitle}>
            Enter the 6-digit OTP sent to:
          </Text>
          <Text style={styles.otpEmail}>{email}</Text>

          <View style={styles.otpPurposeBadge}>
            <Text style={styles.otpPurposeText}>
              {getPurposeText()}
            </Text>
          </View>

          {/* UPDATED: Added proper label above the input */}
          <Text style={styles.otpInputLabel}>Enter 6-digit OTP</Text>
          <TextInput
            style={styles.otpInput}
            placeholder="000000"
            value={otp}
            onChangeText={setOtp}
            keyboardType="number-pad"
            maxLength={6}
            autoFocus={true}
            placeholderTextColor="#999"
            textAlign="center"
          />

          {/* UPDATED BUTTONS LAYOUT - Green button first, then Resend below */}
          <View style={styles.otpButtonsColumn}>
            <TouchableOpacity 
              style={[styles.otpButton, styles.verifyButton, isLoading && styles.disabledButton]}
              onPress={handleVerify}
              disabled={isLoading}
            >
              <Text style={styles.verifyButtonText}>
                {isLoading ? 'Verifying...' : `Submit OTP`}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.resendButton, (countdown > 0 || resendLoading) && styles.disabledButton]}
              onPress={handleResend}
              disabled={countdown > 0 || resendLoading}
            >
              <Text style={styles.resendButtonText}>
                {resendLoading ? 'Sending...' : countdown > 0 ? `Resend (${countdown}s)` : 'Resend OTP'}
              </Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.otpHint}>
            💡 Check your spam folder if you don't see the email
          </Text>
        </View>
      </View>
    </Modal>
  );
};

const ScheduleModal = ({ visible, onClose, onSave, sensorId, plantName, existingSchedules }) => {
  const [schedules, setSchedules] = useState(getDefaultSchedules());

  useEffect(() => {
    if (visible) {
      setSchedules(existingSchedules || getDefaultSchedules());
    }
  }, [visible, existingSchedules]);

  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const minutes = Array.from({ length: 60 }, (_, i) => i);

  const updateSchedule = (index, field, value) => {
    const newSchedules = [...schedules];
    newSchedules[index] = { ...newSchedules[index], [field]: value };
    setSchedules(newSchedules);
  };

  const toggleDay = (scheduleIndex, dayIndex) => {
    const newSchedules = [...schedules];
    const currentDays = newSchedules[scheduleIndex].days;
    const dayMask = 1 << dayIndex;
    
    if (currentDays & dayMask) {
      newSchedules[scheduleIndex].days = currentDays & ~dayMask;
    } else {
      newSchedules[scheduleIndex].days = currentDays | dayMask;
    }
    
    setSchedules(newSchedules);
  };

  const isDaySelected = (scheduleIndex, dayIndex) => {
    return (schedules[scheduleIndex].days & (1 << dayIndex)) !== 0;
  };

  const selectAllDays = (scheduleIndex) => {
    updateSchedule(scheduleIndex, 'days', 127);
  };

  const clearAllDays = (scheduleIndex) => {
    updateSchedule(scheduleIndex, 'days', 0);
  };

  const handleSave = () => {
    console.log("Saving schedules for sensor:", sensorId);
    console.log("Schedules data:", schedules);
    onSave(sensorId, schedules);
    onClose();
  };

  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={[styles.modalContent, { maxHeight: '85%', width: '90%', maxWidth: 400 }]}>
          
          <View style={styles.scheduleHeader}>
            <View>
              <Text style={styles.modalTitle}>Watering Schedule</Text>
              <Text style={styles.modalSubtitle}>For {plantName} (Sensor {sensorId + 1})</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.warningText}>
            ⚠️ Uses your phone's local time and day
          </Text>

          <ScrollView style={{ width: '100%' }} showsVerticalScrollIndicator={false}>
            {schedules.map((schedule, index) => (
              <View key={index} style={styles.scheduleCard}>
                <View style={styles.scheduleCardHeader}>
                  <Text style={styles.scheduleNumber}>Schedule {index + 1}</Text>
                  <View style={styles.switchContainer}>
                    <Text style={styles.switchLabel}>
                      {schedule.enabled ? 'Enabled' : 'Disabled'}
                    </Text>
                    <Switch
                      value={schedule.enabled}
                      onValueChange={(value) => updateSchedule(index, 'enabled', value)}
                      trackColor={{ false: '#767577', true: '#81b0ff' }}
                      thumbColor={schedule.enabled ? '#4CAF50' : '#f4f3f4'}
                    />
                  </View>
                </View>

                {schedule.enabled && (
                  <View style={styles.scheduleContent}>
                    <View style={styles.timeSection}>
                      <Text style={styles.sectionTitle}>Time (24-hour format)</Text>
                      <View style={styles.timePickersContainer}>
                        <View style={styles.pickerColumn}>
                          <Text style={styles.pickerLabel}>Hour</Text>
                          <View style={styles.pickerWrapper}>
                            <Picker
                              selectedValue={schedule.hour}
                              onValueChange={(value) => updateSchedule(index, 'hour', value)}
                              style={styles.picker}
                              mode="dropdown"
                            >
                              {hours.map((hour) => (
                                <Picker.Item 
                                  key={hour} 
                                  label={hour.toString().padStart(2, '0')} 
                                  value={hour} 
                                />
                              ))}
                            </Picker>
                          </View>
                        </View>
                        
                        <Text style={styles.timeSeparator}>:</Text>
                        
                        <View style={styles.pickerColumn}>
                          <Text style={styles.pickerLabel}>Minute</Text>
                          <View style={styles.pickerWrapper}>
                            <Picker
                              selectedValue={schedule.minute}
                              onValueChange={(value) => updateSchedule(index, 'minute', value)}
                              style={styles.picker}
                              mode="dropdown"
                            >
                              {minutes.map((minute) => (
                                <Picker.Item 
                                  key={minute} 
                                  label={minute.toString().padStart(2, '0')} 
                                  value={minute} 
                                />
                              ))}
                            </Picker>
                          </View>
                        </View>
                      </View>
                      <Text style={styles.selectedTime}>
                        Set for: {schedule.hour.toString().padStart(2, '0')}:{schedule.minute.toString().padStart(2, '0')}
                      </Text>
                    </View>

                    <View style={styles.daysSection}>
                      <ProfessionalDaysSelector
                        selectedDays={schedule.days}
                        onDaysChange={(newDays) => updateSchedule(index, 'days', newDays)}
                      />
                    </View>
                  </View>
                )}
              </View>
            ))}
          </ScrollView>

          <View style={styles.footerButtons}>
            <TouchableOpacity 
              style={[styles.footerButton, styles.cancelButton]} 
              onPress={onClose}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[styles.footerButton, styles.saveButton]} 
              onPress={handleSave}
            >
              <Text style={styles.saveButtonText}>Save Schedules</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const ProfessionalDaysSelector = ({ selectedDays, onDaysChange }) => {
  const days = [
    { short: 'S', full: 'Sun' },
    { short: 'M', full: 'Mon' },
    { short: 'T', full: 'Tue' },
    { short: 'W', full: 'Wed' },
    { short: 'T', full: 'Thu' },
    { short: 'F', full: 'Fri' },
    { short: 'S', full: 'Sat' }
  ];

  const toggleDay = (dayIndex) => {
    const dayMask = 1 << dayIndex;
    const newDays = selectedDays ^ dayMask;
    onDaysChange(newDays);
  };

  const isDaySelected = (dayIndex) => {
    return (selectedDays & (1 << dayIndex)) !== 0;
  };

  const getSelectedDaysText = () => {
    if (selectedDays === 127) return 'Every day';
    if (selectedDays === 0) return 'Never';
    
    const selected = days.filter((_, index) => isDaySelected(index));
    if (selected.length === 7) return 'Every day';
    if (selected.length === 5 && !isDaySelected(0) && !isDaySelected(6)) return 'Weekdays';
    if (selected.length === 2 && isDaySelected(0) && isDaySelected(6)) return 'Weekends';
    
    return selected.map(day => day.full).join(', ');
  };

  return (
    <View style={styles.professionalContainer}>
      <View style={styles.proHeader}>
        <Text style={styles.proTitle}>Repeat on</Text>
        <View style={styles.proBadge}>
          <Text style={styles.proBadgeText}>
            {days.filter((_, index) => isDaySelected(index)).length}/7 days
          </Text>
        </View>
      </View>
      
      {/* Centered Days Grid */}
      <View style={styles.proGrid}>
        {days.map((day, index) => (
          <View key={index} style={styles.dayColumn}>
            <TouchableOpacity
              style={[
                styles.proDayCard,
                isDaySelected(index) && styles.proDayCardSelected,
                (index === 0 || index === 6) && styles.weekendDay
              ]}
              onPress={() => toggleDay(index)}
            >
              <Text style={[
                styles.proDayShort,
                isDaySelected(index) && styles.proDayShortSelected
              ]}>
                {day.short}
              </Text>
              <Text style={[
                styles.proDayFull,
                isDaySelected(index) && styles.proDayFullSelected
              ]}>
                {day.full}
              </Text>
            </TouchableOpacity>
          </View>
        ))}
      </View>
      
      <View style={styles.proSummary}>
        <Text style={styles.proSummaryText}>{getSelectedDaysText()}</Text>
      </View>
      
      {/* Centered Quick Actions */}
      <View style={styles.proQuickActions}>
        <TouchableOpacity 
          style={styles.proQuickButton} 
          onPress={() => onDaysChange(127)}
        >
          <Text style={styles.proQuickButtonText}>All Days</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.proQuickButton} 
          onPress={() => onDaysChange(62)} // Weekdays (Mon-Fri)
        >
          <Text style={styles.proQuickButtonText}>Weekdays</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={styles.proQuickButton} 
          onPress={() => onDaysChange(65)} // Weekends (Sat-Sun)
        >
          <Text style={styles.proQuickButtonText}>Weekends</Text>
        </TouchableOpacity>
        <TouchableOpacity 
          style={[styles.proQuickButton, styles.proQuickButtonClear]} 
          onPress={() => onDaysChange(0)}
        >
          <Text style={styles.proQuickButtonClearText}>Clear</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const PlantDetailsModal = ({ visible, onClose, plant, moistureData, onRenameRequest, onScheduleRequest, onShowHistory, sensorId, userId }) => {
  const [autoModeEnabled, setAutoModeEnabled] = useState(false);
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  const isSensor3 = sensorId === 2;

  useEffect(() => {
    if (visible && sensorId !== null) {
      loadAutoModeStatus(sensorId);
      loadNotificationPreference();
    }
  }, [visible, sensorId]);

  const loadAutoModeStatus = async (sensorIndex) => {
    try {
      const autoModeRef = ref(db, `AutoMode/Sensor${sensorIndex + 1}`);
      const snapshot = await get(autoModeRef);
      if (snapshot.exists()) {
        const data = snapshot.val();
        setAutoModeEnabled(data.enabled || false);
      } else {
        setAutoModeEnabled(false);
      }
    } catch (error) {
      console.error("Error loading auto mode:", error);
      setAutoModeEnabled(false);
    }
  };

  const loadNotificationPreference = async () => {
    try {
      const preference = await AsyncStorage.getItem('moistureNotifications');
      if (preference !== null) {
        setNotificationEnabled(JSON.parse(preference));
      }
    } catch (error) {
      console.error('Error loading notification preference:', error);
    }
  };

  const toggleAutoMode = async (enabled) => {
    try {
      const autoModeRef = ref(db, `AutoMode/Sensor${sensorId + 1}`);
      await update(autoModeRef, {
        enabled: enabled,
        lastUpdated: new Date().toISOString(),
        sensorId: sensorId + 1
      });
      
      setAutoModeEnabled(enabled);
      Alert.alert("Success", `Auto mode ${enabled ? "enabled" : "disabled"} for ${plant.name}`);
    } catch (error) {
      console.error("Error updating auto mode:", error);
      Alert.alert("Error", "Failed to update auto mode");
    }
  };

  const toggleNotifications = async (enabled) => {
    setNotificationEnabled(enabled);
    try {
      await AsyncStorage.setItem('moistureNotifications', JSON.stringify(enabled));
      
      if (enabled && plant && moistureData !== null) {
        // Send test notification when enabling
        await scheduleMoistureNotification(
          "🔔 Notifications Enabled",
          `You'll receive alerts for ${plant.name} when moisture levels change significantly.`
        );
      }
    } catch (error) {
      console.error('Error saving notification preference:', error);
    }
  };

  const handleManualPump = async (action) => {
    const success = await controlPump(sensorId, action);
    if (success) {
      Alert.alert("Success", `Pump ${action} command sent for ${plant.name}`);
    } else {
      Alert.alert("Error", "Failed to send pump command");
    }
  };

  const showPumpControls = () => {
    Alert.alert(
      "Manual Pump Control",
      `Control water pump for ${plant.name}`,
      [
        {
          text: "Turn ON Pump",
          onPress: () => handleManualPump("ON"),
          style: "default"
        },
        {
          text: "Turn OFF Pump",
          onPress: () => handleManualPump("OFF"),
          style: "destructive"
        },
        {
          text: "Cancel",
          style: "cancel"
        }
      ]
    );
  };

  const getMoistureStatus = () => {
    if (moistureData === null) return { label: "No data", color: "#9E9E9E", icon: "?" };
    if (moistureData >= 800) return { label: "Dry", color: "#FF5722", icon: "🌵" };
    if (moistureData >= 400) return { label: "Moist", color: "#4CAF50", icon: "🌱" };
    return { label: "Wet", color: "#2196F3", icon: "💧" };
  };

  const status = getMoistureStatus();

  if (!plant) return null;

  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.centeredModalContainer}>
        <View style={[styles.improvedModalContent, { maxHeight: "85%", width: "92%" }]}>
          
          <View style={styles.modalHeader}>
            <View>
              <Text style={styles.modalTitleLarge}>{plant.name}</Text>
              <Text style={styles.modalSensorInfo}>Sensor {plant.sensorId}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            
            {!isSensor3 && (
              <View style={[styles.sectionCard, styles.moistureSectionCard]}>
                <View style={styles.moistureContentWrapper}>
                  <View style={styles.moistureLeft}>
                    <Text style={styles.moistureIcon}>{status.icon}</Text>
                    <Text style={[styles.moistureStatusLabel, { color: status.color }]}>
                      {status.label}
                    </Text>
                  </View>

                  <View style={styles.moistureRight}>
                    <Text style={styles.moistureNumber}>{moistureData !== null ? moistureData : "—"}</Text>
                    <Text style={styles.moistureUnit}>/1023</Text>
                  </View>
                </View>

                <View style={styles.moistureBarContainer}>
                  <View
                    style={[
                      styles.moistureBarFill,
                      { 
                        backgroundColor: status.color,
                        width: `${moistureData ? Math.min(100, (moistureData / 1023) * 100) : 0}%`
                      },
                    ]}
                  />
                </View>

                <View style={styles.moistureScaleContainer}>
                  <View style={styles.scaleItem}>
                    <Text style={styles.scaleValue}>0</Text>
                    <Text style={styles.scaleLabel}>Wet</Text>
                  </View>
                  <View style={styles.scaleItem}>
                    <Text style={styles.scaleValue}>400</Text>
                    <Text style={styles.scaleLabel}>Moist</Text>
                  </View>
                  <View style={styles.scaleItem}>
                    <Text style={styles.scaleValue}>800</Text>
                    <Text style={styles.scaleLabel}>Dry</Text>
                  </View>
                </View>
              </View>
            )}

            {/* NOTIFICATION CONTROL SECTION */}
            <View style={[styles.sectionCard, styles.notificationSectionCard]}>
              <View style={styles.notificationHeader}>
                <View style={styles.notificationTextContainer}>
                  <Text style={styles.notificationTitle}>Moisture Alerts</Text>
                  <Text style={styles.notificationDescription}>
                    Get notified when soil moisture changes significantly
                  </Text>
                </View>
                <Switch
                  value={notificationEnabled}
                  onValueChange={toggleNotifications}
                  trackColor={{ false: '#767577', true: '#81b0ff' }}
                  thumbColor={notificationEnabled ? '#4CAF50' : '#f4f3f4'}
                  ios_backgroundColor="#3e3e3e"
                />
              </View>
              <Text style={styles.notificationHint}>
                {notificationEnabled 
                  ? "🔔 Alerts enabled - You'll be notified of significant moisture changes" 
                  : "🔕 Alerts disabled - No notifications will be sent"}
              </Text>
              
              {notificationEnabled && (
                <TouchableOpacity 
                  style={styles.testNotificationButton}
                  onPress={async () => {
                    if (plant) {
                      await scheduleMoistureNotification(
                        "🔔 Test Notification",
                        `This is a test notification for ${plant.name}. You'll receive similar alerts when moisture levels change.`,
                        { test: true, plantName: plant.name }
                      );
                      Alert.alert("Test Sent", "Test notification sent successfully!");
                    }
                  }}
                >
                  <Text style={styles.testNotificationText}>Send Test Notification</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={[styles.sectionCard, styles.autoModeSectionCard]}>
              <View style={styles.autoModeHeader}>
                <View style={styles.autoModeTextContainer}>
                  <Text style={styles.autoModeTitle}>Auto Mode</Text>
                  <Text style={styles.autoModeDescription}>
                    Automatically water plant when soil is dry
                  </Text>
                </View>
                <Switch
                  value={autoModeEnabled}
                  onValueChange={toggleAutoMode}
                  trackColor={{ false: '#767577', true: '#81b0ff' }}
                  thumbColor={autoModeEnabled ? '#4CAF50' : '#f4f3f4'}
                  ios_backgroundColor="#3e3e3e"
                />
              </View>
              <Text style={styles.autoModeHint}>
                {autoModeEnabled 
                  ? "✅ Auto mode is ON - Plant will be watered automatically when dry" 
                  : "❌ Auto mode is OFF - Plant requires manual watering"}
              </Text>
            </View>

            <View style={[styles.sectionCard, styles.detailsSectionCard]}>
              <Text style={styles.sectionLabel}>Details</Text>
              
              <View style={styles.detailRow}>
                <View style={styles.detailLeft}>
                  <Text style={styles.detailIcon}>📊</Text>
                  <View>
                    <Text style={styles.detailLabel}>Raw Value</Text>
                    <Text style={styles.detailSmallText}>0 to 1023 scale</Text>
                  </View>
                </View>
                <Text style={styles.detailValue}>
                  {moistureData !== null ? moistureData : "N/A"}
                </Text>
              </View>

              <View style={styles.detailDivider} />

              <View style={styles.detailRow}>
                <View style={styles.detailLeft}>
                  <Text style={styles.detailIcon}>📅</Text>
                  <View>
                    <Text style={styles.detailLabel}>Registered</Text>
                    <Text style={styles.detailSmallText}>Setup date</Text>
                  </View>
                </View>
                <Text style={styles.detailValue}>
                  {new Date(plant.registeredAt).toLocaleDateString()}
                </Text>
              </View>
            </View>

            <View style={styles.quickActionsSection}>
              <Text style={styles.sectionLabel}>Actions</Text>
              
              <TouchableOpacity 
                style={styles.primaryActionButton}
                onPress={showPumpControls}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryActionEmoji}>💧</Text>
                <Text style={styles.primaryActionText}>Manual Pump Control</Text>
              </TouchableOpacity>

              <View style={styles.secondaryActionsRow}>
                <TouchableOpacity 
                  style={[styles.secondaryActionButton, { borderColor: "#4CAF50" }]}
                  onPress={() => {
                    onClose();
                    setTimeout(onRenameRequest, 250);
                  }}
                >
                  <Text style={styles.secondaryActionEmoji}>✏️</Text>
                  <Text style={[styles.secondaryActionLabel, { color: "#4CAF50" }]}>Rename</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.secondaryActionButton, { borderColor: "#FF9800" }]}
                  onPress={() => {
                    onClose();
                    setTimeout(onScheduleRequest, 250);
                  }}
                >
                  <Text style={styles.secondaryActionEmoji}>⏰</Text>
                  <Text style={[styles.secondaryActionLabel, { color: "#FF9800" }]}>Schedule</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                  style={[styles.secondaryActionButton, { borderColor: "#2196F3" }]}
                  onPress={() => {
                    onClose();
                    setTimeout(onShowHistory, 250);
                  }}
                >
                  <Text style={styles.secondaryActionEmoji}>📈</Text>
                  <Text style={[styles.secondaryActionLabel, { color: "#2196F3" }]}>History</Text>
                </TouchableOpacity>
              </View>
            </View>

          </ScrollView>

        </View>
      </View>
    </Modal>
  );
};

const RenameModal = ({ visible, onClose, onRename, currentName }) => {
  const [name, setName] = useState("");

  useEffect(() => {
    if (visible) {
      setName(currentName || "");
    }
  }, [currentName, visible]);

  const handleApply = () => {
    if (!name.trim()) {
      Alert.alert("Error", "Please enter a name");
      return;
    }
    onRename(name.trim());
    onClose();
  };

  return (
    <Modal animationType="fade" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>Rename Plant</Text>
          <TextInput 
            style={styles.input} 
            value={name} 
            onChangeText={setName} 
            placeholder="New plant name" 
          />
          <View style={styles.modalButtons}>
            <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={onClose}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.modalButton, styles.connectButton]} onPress={handleApply}>
              <Text style={styles.connectButtonText}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const ActionModal = ({ visible, onClose, title, message, actions }) => {
  return (
    <Modal animationType="fade" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.actionModalContainer}>
        <View style={styles.actionModalContent}>
          <Text style={styles.actionModalTitle}>{title}</Text>
          {message && <Text style={styles.actionModalMessage}>{message}</Text>}
          
          <View style={styles.actionButtonsContainer}>
            {actions.map((action, index) => (
              <TouchableOpacity
                key={index}
                style={[
                  styles.actionButton,
                  action.style === 'cancel' && styles.actionButtonCancel,
                  action.style === 'destructive' && styles.actionButtonDestructive,
                ]}
                onPress={() => {
                  onClose();
                  if (action.onPress) action.onPress();
                }}
              >
                <Text style={[
                  styles.actionButtonText,
                  action.style === 'cancel' && styles.actionButtonTextCancel,
                  action.style === 'destructive' && styles.actionButtonTextDestructive,
                ]}>
                  {action.text}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
};

const ConfirmationModal = ({ visible, onClose, title, message, onConfirm, confirmText = "Delete", cancelText = "Cancel" }) => {
  return (
    <Modal animationType="fade" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.actionModalContainer}>
        <View style={styles.actionModalContent}>
          <Text style={styles.actionModalTitle}>{title}</Text>
          <Text style={styles.actionModalMessage}>{message}</Text>
          
          <View style={styles.confirmationButtonsRow}>
            <TouchableOpacity
              style={[styles.confirmationButton, styles.confirmationCancelButton]}
              onPress={onClose}
            >
              <Text style={styles.confirmationCancelText}>{cancelText}</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={[styles.confirmationButton, styles.confirmationDeleteButton]}
              onPress={() => {
                onClose();
                onConfirm();
              }}
            >
              <Text style={styles.confirmationDeleteText}>{confirmText}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
};

const HistoryModal = ({ visible, onClose, history }) => {
  return (
    <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={[styles.modalContent, { maxHeight: "80%", width: "90%" }]}>
          <Text style={styles.modalTitle}>History</Text>
          
          {history && history.length > 0 ? (
            <FlatList
              data={history}
              keyExtractor={(item, index) => index.toString()}
              renderItem={({ item }) => (
                <View style={styles.historyItem}>
                  <Text style={styles.historyTime}>{item.timestamp}</Text>
                  <View style={styles.historyDetails}>
                    <Text style={[
                      styles.historyStatus,
                      { 
                        color: item.status === "Dry" ? "#FF5722" :
                               item.status === "Moist" ? "#4CAF50" : "#2196F3"
                      }
                    ]}>
                      {item.status}
                    </Text>
                    <Text style={styles.historyValue}>{item.value}</Text>
                  </View>
                </View>
              )}
            />
          ) : (
            <Text style={styles.noHistoryText}>No history data available</Text>
          )}

          <TouchableOpacity style={[styles.modalButton, styles.cancelButton, { marginTop: 12 }]} onPress={onClose}>
            <Text style={styles.cancelButtonText}>Close</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
};

const DeviceActionModal = ({ visible, onClose, device, hasAccess, onViewSensors, onOpenWeb, onRename, onDelete }) => {
  if (!device) return null;

  return (
    <Modal animationType="fade" transparent={true} visible={visible} onRequestClose={onClose}>
      <View style={styles.deviceActionModalContainer}>
        <View style={styles.deviceActionModalContent}>
          
          <View style={styles.deviceModalHeader}>
            <View>
              <Text style={styles.deviceModalTitle}>{device.name}</Text>
              <Text style={styles.deviceModalSubtitle}>{device.ip}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          <View style={[styles.statusBanner, { backgroundColor: hasAccess ? "#E8F5E9" : "#FFF3E0" }]}>
            <View style={[styles.statusDot, { backgroundColor: hasAccess ? "#4CAF50" : "#FF9800" }]} />
            <Text style={[styles.statusBannerText, { color: hasAccess ? "#2E7D32" : "#E65100" }]}>
              {hasAccess ? "✓ Full Access" : "⚠ Limited Access"}
            </Text>
          </View>

          <View style={styles.deviceInfoCard}>
            <View style={styles.infoRow}>
              <Text style={styles.infoLabel}>IP Address</Text>
              <Text style={styles.infoValue}>{device.ip}</Text>
            </View>
            <View style={[styles.infoRow, { borderTopWidth: 1, borderTopColor: "rgba(0,0,0,0.05)", paddingTop: 12, marginTop: 12 }]}>
              <Text style={styles.infoLabel}>Registered</Text>
              <Text style={styles.infoValue}>{new Date(device.registeredAt).toLocaleDateString()}</Text>
            </View>
          </View>

          <TouchableOpacity 
            style={[
              styles.deviceActionButtonPrimary,
              { opacity: hasAccess ? 1 : 0.5 }
            ]}
            onPress={onViewSensors}
            disabled={!hasAccess}
          >
            <Text style={styles.deviceActionButtonPrimaryText}>
              📊 View Sensors
            </Text>
            {!hasAccess && <Text style={styles.disabledText}>Requires correct IP</Text>}
          </TouchableOpacity>

          <View style={styles.deviceActionButtonsRow}>
            <TouchableOpacity 
              style={styles.deviceActionButtonSecondary}
              onPress={onOpenWeb}
            >
              <Text style={styles.deviceActionButtonSecondaryText}>🌐</Text>
              <Text style={styles.deviceActionButtonSecondaryLabel}>Web UI</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={styles.deviceActionButtonSecondary}
              onPress={onRename}
            >
              <Text style={styles.deviceActionButtonSecondaryText}>✏️</Text>
              <Text style={styles.deviceActionButtonSecondaryLabel}>Rename</Text>
            </TouchableOpacity>

            <TouchableOpacity 
              style={[styles.deviceActionButtonSecondary, styles.deviceActionButtonDelete]}
              onPress={onDelete}
            >
              <Text style={styles.deviceActionButtonSecondaryText}>🗑️</Text>
              <Text style={[styles.deviceActionButtonSecondaryLabel, { color: "#FF5722" }]}>Delete</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity 
            style={styles.deviceCloseButton}
            onPress={onClose}
          >
            <Text style={styles.deviceCloseButtonText}>Close</Text>
          </TouchableOpacity>

        </View>
      </View>
    </Modal>
  );
};

// Updated SelectionScreen for Multi-User
const SelectionScreen = ({ navigation, route }) => {
  const { user } = route.params || {};
  const [modalVisible, setModalVisible] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [ipAddress, setIpAddress] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [devices, setDevices] = useState({});
  const [actionModalVisible, setActionModalVisible] = useState(false);
  const [actionModalConfig, setActionModalConfig] = useState({ title: '', message: '', actions: [] });
  const [confirmModalVisible, setConfirmModalVisible] = useState(false);
  const [confirmModalConfig, setConfirmModalConfig] = useState({ title: '', message: '', onConfirm: () => {} });
  const [deviceActionModalVisible, setDeviceActionModalVisible] = useState(false);
  const [selectedDeviceAction, setSelectedDeviceAction] = useState({ device: null, deviceId: null, hasAccess: false });
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [nickname, setNickname] = useState("");
  const [isMuted, setIsMuted] = useState(false);
  
  // ADD THIS SIMPLE DRAWER STATE
  const [drawerVisible, setDrawerVisible] = useState(false);

  // ADD THESE SIMPLE DRAWER FUNCTIONS
  const toggleDrawer = () => {
    setDrawerVisible(!drawerVisible);
  };

  const closeDrawer = () => {
    setDrawerVisible(false);
  };

  useEffect(() => {
    if (!user) return;

    const devicesRef = ref(db, `Users/${user.uid}/devices`);
    const unsub = onValue(devicesRef, (snapshot) => {
      if (snapshot.exists()) {
        setDevices(snapshot.val());
      } else {
        setDevices({});
      }
    });

    return () => unsub && unsub();
  }, [user]);

  // Load user settings
  useEffect(() => {
    if (user) {
      loadUserSettings();
    }
  }, [user]);

  const loadUserSettings = async () => {
    try {
      const settingsRef = ref(db, `Users/${user.uid}/settings`);
      const snapshot = await get(settingsRef);
      if (snapshot.exists()) {
        const settings = snapshot.val();
        setNickname(settings.nickname || "");
        setIsMuted(settings.isMuted || false);
      }
    } catch (error) {
      console.error("Error loading settings:", error);
    }
  };

  const saveUserSettings = async () => {
    try {
      const settingsRef = ref(db, `Users/${user.uid}/settings`);
      await update(settingsRef, {
        nickname: nickname,
        isMuted: isMuted,
        updatedAt: new Date().toISOString()
      });
      Alert.alert("Success", "Settings saved successfully");
      setSettingsModalVisible(false);
    } catch (error) {
      console.error("Error saving settings:", error);
      Alert.alert("Error", "Failed to save settings");
    }
  };

  const proceedWithRegistration = () => {
    if (ipAddress !== ALLOWED_IP) {
      Alert.alert(
        "Note", 
        `This device (${ipAddress}) will not display sensor data.\nOnly devices with IP ${ALLOWED_IP} can access sensor data.`,
        [{ text: "OK" }]
      );
    }

    const deviceId = generateDeviceId();
    const accessToken = generateAccessToken();
    const deviceData = { 
      ip: ipAddress, 
      registeredAt: new Date().toISOString(),
      name: deviceName || `Device ${Object.keys(devices).length + 1}`,
      accessToken: accessToken,
      deviceId: deviceId,
      slot: selectedSlot,
      userId: user.uid
    };

    update(ref(db), {
      [`Users/${user.uid}/devices/${deviceId}`]: deviceData,
    })
      .then(() => {
        setIpAddress("");
        setDeviceName("");
        setModalVisible(false);
        setSelectedSlot(null);
        
        const newDeviceCount = getDeviceCountForIPAndUser(devices, ipAddress, user.uid) + 1;
        let successMessage = "Device registered successfully!\n\nAccess Token: " + accessToken;
        
        if (newDeviceCount === 3) {
          successMessage += "\n\n⚠️ This IP address has reached the maximum of 3 devices for your account.";
        } else if (newDeviceCount === 2) {
          successMessage += "\n\nℹ️ You can register 1 more device with this IP address.";
        }
        
        Alert.alert("Success", successMessage);
      })
      .catch((err) => {
        Alert.alert("Error", "Could not register device: " + err.message);
      });
  };

  const handleRegisterDevice = () => {
    if (!ipAddress) {
      Alert.alert("Error", "Please enter an IP address");
      return;
    }

    const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipRegex.test(ipAddress)) {
      Alert.alert("Error", "Please enter a valid IP address");
      return;
    }

    // Check device limit for this IP for current user
    const deviceCount = getDeviceCountForIPAndUser(devices, ipAddress, user.uid);
    if (deviceCount >= 3) {
      Alert.alert(
        "Device Limit Reached",
        `You have already registered 3 devices with IP ${ipAddress}.\n\nEach user can register a maximum of 3 devices per IP address.`,
        [{ text: "OK" }]
      );
      return;
    }

    // Show warning when approaching limit
    if (deviceCount === 2) {
      Alert.alert(
        "Warning - Last Available Slot",
        `You already have 2 devices registered with IP ${ipAddress}.\n\nYou can only register 1 more device with this IP address.`,
        [{ text: "Continue", onPress: proceedWithRegistration }, { text: "Cancel" }]
      );
      return;
    }

    proceedWithRegistration();
  };

  const handleRenameDevice = (newName) => {
    if (!selectedSlot || !newName.trim() || !user) {
      Alert.alert("Error", "Please enter a valid device name");
      return;
    }

    const deviceUpdates = {
      name: newName.trim(),
      updatedAt: new Date().toISOString()
    };

    update(ref(db, `Users/${user.uid}/devices/${selectedSlot}`), deviceUpdates)
      .then(() => {
        setRenameModalVisible(false);
        setDeviceName("");
        setSelectedSlot(null);
        Alert.alert("Success", "Device renamed successfully");
      })
      .catch((err) => {
        Alert.alert("Error", "Could not rename device: " + err.message);
      });
  };

  const handleDeleteDevice = (deviceId) => {
    if (!deviceId || !user) return;
    
    setConfirmModalConfig({
      title: "Delete Device",
      message: "Are you sure you want to delete this device? This will remove it from your account.",
      onConfirm: () => {
        update(ref(db), {
          [`Users/${user.uid}/devices/${deviceId}`]: null
        })
          .then(() => {
            Alert.alert("Success", "Device deleted successfully");
          })
          .catch((err) => {
            Alert.alert("Error", "Could not delete device: " + err.message);
          });
      }
    });
    setConfirmModalVisible(true);
  };

  const handleOpenDevice = (device) => {
    if (device && device.ip) {
      const url = `http://${device.ip}`;
      Linking.openURL(url).catch(() => {
        Alert.alert("Error", "Could not open device web interface");
      });
    } else {
      Alert.alert("Error", "Device IP address not available");
    }
  };

  const handleDevicePress = (deviceId, device) => {
    if (device) {
      const hasAccess = device.ip === ALLOWED_IP;
      
      setSelectedDeviceAction({
        device: device,
        deviceId: deviceId,
        hasAccess: hasAccess,
      });
      setDeviceActionModalVisible(true);
    } else {
      setSelectedSlot(deviceId);
      setModalVisible(true);
    }
  };

  const handleDeviceLongPress = (deviceId, device) => {
    if (device) {
      handleDeleteDevice(deviceId);
    } else {
      setSelectedSlot(deviceId);
      setModalVisible(true);
    }
  };

  const renderDeviceSlots = () => {
    const deviceEntries = Object.entries(devices);
    const maxSlots = 4;
    
    return Array.from({ length: maxSlots }).map((_, index) => {
      const deviceForSlot = deviceEntries[index] ? 
        { id: deviceEntries[index][0], ...deviceEntries[index][1] } : 
        null;

      return (
        <TouchableOpacity
          key={index}
          style={[styles.deviceSlot, deviceForSlot ? styles.registeredDevice : {}]}
          onPress={() => handleDevicePress(deviceForSlot ? deviceForSlot.id : `slot_${index}`, deviceForSlot)}
          onLongPress={() => handleDeviceLongPress(deviceForSlot ? deviceForSlot.id : `slot_${index}`, deviceForSlot)}
          delayLongPress={500}
        >
          {deviceForSlot ? (
            <View style={styles.deviceContent}>
              <Text style={styles.deviceName}>{deviceForSlot.name || `Device ${index + 1}`}</Text>
              <Text style={[
                styles.deviceIp, 
                { color: deviceForSlot.ip === ALLOWED_IP ? "#4CAF50" : "#FF9800", fontWeight: "bold" }
              ]}>
                {deviceForSlot.ip} {deviceForSlot.ip === ALLOWED_IP ? "✓" : "⚠"}
              </Text>
              <Text style={styles.deviceDate}>
                Registered: {new Date(deviceForSlot.registeredAt).toLocaleDateString()}
              </Text>
              <Text style={styles.longPressHint}>Long press to delete</Text>
            </View>
          ) : (
            <View style={styles.deviceContent}>
              <Text style={styles.plusText}>+</Text>
              <Text style={styles.addDeviceText}>Add Device</Text>
              <Text style={styles.slotText}>Slot {index + 1}</Text>
            </View>
          )}
        </TouchableOpacity>
      );
    });
  };

  return (
    <View style={[styles.container, styles.selectionBg]}>
      {/* Overlay when drawer is open */}
      {drawerVisible && (
        <TouchableOpacity 
          style={styles.overlay}
          onPress={closeDrawer}
          activeOpacity={1}
        />
      )}

      {/* Slide-Out Navigation Drawer */}
      <View style={[
        styles.drawer,
        { left: drawerVisible ? 0 : -300 } // Simple show/hide without animation
      ]}>
        <View style={styles.drawerContent}>
          {/* User Info in Drawer */}
          <View style={styles.drawerHeader}>
            <Text style={styles.drawerWelcome}>
              Welcome, {nickname || user?.email}
            </Text>
            {nickname && (
              <Text style={styles.drawerEmail}>{user?.email}</Text>
            )}
          </View>

          <View style={styles.drawerDivider} />

          {/* Navigation Items */}
          <TouchableOpacity 
            style={styles.drawerItem}
            onPress={() => {
              closeDrawer();
              setSettingsModalVisible(true);
            }}
          >
            <Text style={styles.drawerItemIcon}>⚙️</Text>
            <Text style={styles.drawerItemText}>Account Settings</Text>
          </TouchableOpacity>

          <TouchableOpacity 
            style={styles.drawerItem}
            onPress={() => {
              closeDrawer();
              handleLogout(navigation);
            }}
          >
            <Text style={styles.drawerItemIcon}>🚪</Text>
            <Text style={styles.drawerItemText}>Logout</Text>
          </TouchableOpacity>
        </View>
      </View>

      <LeafDecoration style={{ top: 80, left: 20 }} rotation="-15deg" />
      <SmallLeaf style={{ top: 130, right: 30 }} rotation="65deg" />
      <SmallLeaf style={{ bottom: 150, left: 40 }} rotation="-45deg" />
      <LeafDecoration style={{ bottom: 100, right: 20 }} rotation="75deg" />

      {/* Hamburger Menu Button */}
      <TouchableOpacity 
        style={styles.menuButton}
        onPress={toggleDrawer}
      >
        <Text style={styles.menuButtonIcon}>☰</Text>
      </TouchableOpacity>

      <Text style={styles.title}>Manage Your Devices</Text>
      <Text style={styles.subtitle}>Register or manage your ESP8266 devices</Text>
      
      <Text style={styles.longPressInstruction}>
        💡 Each user can register up to 3 devices per IP address
      </Text>

      <ScrollView contentContainerStyle={styles.devicesGridCentered}>
        {renderDeviceSlots()}
      </ScrollView>

      <Modal animationType="slide" transparent={true} visible={modalVisible} onRequestClose={() => { 
        setModalVisible(false); 
        setIpAddress(""); 
        setDeviceName(""); 
      }}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <Text style={styles.modalTitle}>Register New Device</Text>
            <Text style={styles.modalSubtitle}>Enter details for your device</Text>

            <TextInput
              style={styles.input}
              placeholder="Device Name (optional)"
              value={deviceName}
              onChangeText={setDeviceName}
              autoCapitalize="words"
              autoCorrect={false}
            />

            <TextInput
              style={styles.input}
              placeholder="(192.168.1.1)"
              value={ipAddress}
              onChangeText={setIpAddress}
              keyboardType="numeric"
              autoCapitalize="none"
              autoCorrect={false}
            />

            {/* Device count indicator */}
            {ipAddress && user && (
              <View style={[
                styles.deviceCountBanner, 
                getDeviceCountForIPAndUser(devices, ipAddress, user.uid) >= 3 ? styles.deviceCountFull : {}
              ]}>
                <Text style={styles.deviceCountText}>
                  {getDeviceCountForIPAndUser(devices, ipAddress, user.uid)}/3 devices registered with this IP
                </Text>
                {getDeviceCountForIPAndUser(devices, ipAddress, user.uid) >= 3 && (
                  <Text style={styles.deviceCountWarning}>
                    Your limit reached
                  </Text>
                )}
              </View>
            )}

            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={() => { 
                setModalVisible(false); 
                setIpAddress(""); 
                setDeviceName(""); 
              }}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>

              <TouchableOpacity 
                style={[
                  styles.modalButton, 
                  styles.connectButton,
                  (user && getDeviceCountForIPAndUser(devices, ipAddress, user.uid) >= 3) ? styles.disabledButton : {}
                ]} 
                onPress={handleRegisterDevice}
                disabled={user && getDeviceCountForIPAndUser(devices, ipAddress, user.uid) >= 3}
              >
                <Text style={styles.connectButtonText}>
                  {(user && getDeviceCountForIPAndUser(devices, ipAddress, user.uid) >= 3) ? "Your Limit Reached" : "Register"}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Settings Modal */}
      <Modal animationType="slide" transparent={true} visible={settingsModalVisible} onRequestClose={() => setSettingsModalVisible(false)}>
        <View style={styles.modalContainer}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Account Settings</Text>
              <TouchableOpacity onPress={() => setSettingsModalVisible(false)} style={styles.closeButton}>
                <Text style={styles.closeButtonText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.settingsSection}>
              <Text style={styles.settingsLabel}>Nickname</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter your nickname"
                value={nickname}
                onChangeText={setNickname}
                autoCapitalize="words"
              />
              <Text style={styles.settingsHint}>
                This will be displayed instead of your email
              </Text>
            </View>

            <View style={styles.settingsSection}>
              <View style={styles.switchContainer}>
                <View style={styles.switchTextContainer}>
                  <Text style={styles.settingsLabel}>Sound</Text>
                  <Text style={styles.settingsHint}>
                    {isMuted ? "Muted" : "Enabled"} - Background music control
                  </Text>
                </View>
                <Switch
                  value={!isMuted}
                  onValueChange={(value) => setIsMuted(!value)}
                  trackColor={{ false: '#767577', true: '#81b0ff' }}
                  thumbColor={!isMuted ? '#4CAF50' : '#f4f3f4'}
                />
              </View>
            </View>

            <View style={styles.modalButtons}>
              <TouchableOpacity style={[styles.modalButton, styles.cancelButton]} onPress={() => setSettingsModalVisible(false)}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.modalButton, styles.connectButton]} onPress={saveUserSettings}>
                <Text style={styles.connectButtonText}>Save Settings</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <DeviceRenameModal 
        visible={renameModalVisible} 
        onClose={() => {
          setRenameModalVisible(false);
          setDeviceName("");
          setSelectedSlot(null);
        }} 
        onRename={handleRenameDevice} 
        currentName={deviceName}
      />

      <ActionModal
        visible={actionModalVisible}
        onClose={() => setActionModalVisible(false)}
        title={actionModalConfig.title}
        message={actionModalConfig.message}
        actions={actionModalConfig.actions}
      />

      <ConfirmationModal
        visible={confirmModalVisible}
        onClose={() => setConfirmModalVisible(false)}
        title={confirmModalConfig.title}
        message={confirmModalConfig.message}
        onConfirm={confirmModalConfig.onConfirm}
      />

      <DeviceActionModal
        visible={deviceActionModalVisible}
        onClose={() => setDeviceActionModalVisible(false)}
        device={selectedDeviceAction.device}
        hasAccess={selectedDeviceAction.hasAccess}
        onViewSensors={() => {
          if (selectedDeviceAction.hasAccess) {
            setDeviceActionModalVisible(false);
            navigation.navigate("Plants", { 
              deviceId: selectedDeviceAction.deviceId, 
              device: selectedDeviceAction.device,
              user: user
            });
          } else {
            Alert.alert("Access Denied", `Only devices with IP ${ALLOWED_IP} can access sensor data.`);
          }
        }}
        onOpenWeb={() => {
          setDeviceActionModalVisible(false);
          handleOpenDevice(selectedDeviceAction.device);
        }}
        onRename={() => {
          setDeviceActionModalVisible(false);
          setSelectedSlot(selectedDeviceAction.deviceId);
          setDeviceName(selectedDeviceAction.device.name || `Device`);
          setRenameModalVisible(true);
        }}
        onDelete={() => {
          setDeviceActionModalVisible(false);
          handleDeleteDevice(selectedDeviceAction.deviceId);
        }}
      />
    </View>
  );
};

// Updated PlantsScreen for Multi-User with Plant Guide
const PlantsScreen = ({ navigation, route }) => {
  const { deviceId, device, user } = route.params || {};
  
  const [soilMoisture, setSoilMoisture] = useState(Array(4).fill(null));
  const [history, setHistory] = useState(Array(4).fill([]));
  const [plants, setPlants] = useState(Array(4).fill(null));
  const [devices, setDevices] = useState({});
  const [registrationModalVisible, setRegistrationModalVisible] = useState(false);
  const [detailsModalVisible, setDetailsModalVisible] = useState(false);
  const [renameModalVisible, setRenameModalVisible] = useState(false);
  const [selectedSensor, setSelectedSensor] = useState(null);
  const [selectedPlant, setSelectedPlant] = useState(null);
  const [registeredDevice, setRegisteredDevice] = useState(null);
  const [scheduleModalVisible, setScheduleModalVisible] = useState(false);
  const [selectedSchedules, setSelectedSchedules] = useState(null);
  const [historyModalVisible, setHistoryModalVisible] = useState(false);
  const [actionModalVisible, setActionModalVisible] = useState(false);
  const [actionModalConfig, setActionModalConfig] = useState({ title: '', message: '', actions: [] });
  const [confirmModalVisible, setConfirmModalVisible] = useState(false);
  const [confirmModalConfig, setConfirmModalConfig] = useState({ title: '', message: '', onConfirm: () => {} });
  const [notificationEnabled, setNotificationEnabled] = useState(true);
  
  // NEW STATE VARIABLES FOR PLANT GUIDE
  const [plantGuideModalVisible, setPlantGuideModalVisible] = useState(false);
  const [currentPlantIndex, setCurrentPlantIndex] = useState(0);

  // Plant guide data
  const plantGuideData = [
    {
      id: 1,
      name: "Snake Plant",
      description: "A hardy indoor plant with tall, stiff leaves that purify the air.",
      watering: "Once every 2–3 weeks (let soil dry completely).",
      emoji: "🌱"
    },
    {
      id: 2,
      name: "Peace Lily",
      description: "A beautiful plant with dark green leaves and white blooms; great for low light.",
      watering: "Once a week or when soil feels dry.",
      emoji: "🌸"
    },
    {
      id: 3,
      name: "Pothos (Golden Pothos)",
      description: "A fast-growing vine with heart-shaped green and yellow leaves.",
      watering: "Once every 1–2 weeks.",
      emoji: "🍃"
    },
    {
      id: 4,
      name: "ZZ Plant",
      description: "A low-maintenance plant with shiny, waxy leaves.",
      watering: "Once every 2–3 weeks.",
      emoji: "💫"
    },
    {
      id: 5,
      name: "Chinese Evergreen",
      description: "A colorful, shade-tolerant plant perfect for indoors.",
      watering: "Once a week.",
      emoji: "🎍"
    },
    {
      id: 6,
      name: "Aloe Vera",
      description: "A succulent known for its healing gel and thick leaves.",
      watering: "Once every 3 weeks.",
      emoji: "🌵"
    },
    {
      id: 7,
      name: "Spider Plant",
      description: "A resilient plant with long green-and-white striped leaves.",
      watering: "Once every 1–2 weeks.",
      emoji: "🕷️"
    },
    {
      id: 8,
      name: "Philodendron",
      description: "A lush, green plant that thrives in moderate light and humidity.",
      watering: "Once a week.",
      emoji: "🌿"
    },
    {
      id: 9,
      name: "Succulents/Cacti",
      description: "Drought-tolerant plants that store water in their leaves or stems.",
      watering: "Once every 2–4 weeks.",
      emoji: "🌵"
    },
    {
      id: 10,
      name: "Rubber Plant",
      description: "A glossy-leaved plant that can grow tall indoors.",
      watering: "Once every 1–2 weeks.",
      emoji: "🌳"
    }
  ];

  // Navigation functions for plant guide
  const nextPlant = () => {
    setCurrentPlantIndex((prev) => (prev + 1) % plantGuideData.length);
  };

  const prevPlant = () => {
    setCurrentPlantIndex((prev) => (prev - 1 + plantGuideData.length) % plantGuideData.length);
  };

  const openPlantGuide = () => {
    setCurrentPlantIndex(0);
    setPlantGuideModalVisible(true);
  };

  const shouldDisplaySensorData = (devices) => {
    const allowedDevice = Object.values(devices).find(device => 
      device.ip === ALLOWED_IP
    );
    return !!allowedDevice;
  };

  // Initialize notifications
  useEffect(() => {
    const initializeNotifications = async () => {
      await requestNotificationPermissions();
      
      // Load notification preference
      try {
        const savedPreference = await AsyncStorage.getItem('moistureNotifications');
        if (savedPreference !== null) {
          setNotificationEnabled(JSON.parse(savedPreference));
        }
      } catch (error) {
        console.error('Error loading notification preference:', error);
      }
    };

    initializeNotifications();
  }, []);

  // Toggle notifications
  const toggleNotifications = async (enabled) => {
    setNotificationEnabled(enabled);
    try {
      await AsyncStorage.setItem('moistureNotifications', JSON.stringify(enabled));
      if (enabled) {
        await scheduleMoistureNotification(
          "Notifications Enabled", 
          "You'll now receive alerts when your plants' moisture levels change significantly."
        );
      }
    } catch (error) {
      console.error('Error saving notification preference:', error);
    }
  };

  // ADDED: handleSaveSchedules function
  const handleSaveSchedules = async (sensorId, schedules) => {
    // ADDED: User validation
    if (!user || !user.uid) {
      Alert.alert("Error", "User not authenticated. Please log in again.");
      return;
    }

    try {
      const schedulesForFirebase = {
        schedules: schedules,
        lastUpdated: new Date().toISOString(),
        userId: user.uid // ADDED: Track which user created this schedule
      };

      console.log("Saving schedules for user:", user.uid, schedulesForFirebase);

      // Save to user-specific location
      const userScheduleRef = ref(db, `Schedules/${user.uid}/Sensor${sensorId + 1}`);
      await update(userScheduleRef, schedulesForFirebase);
      
      // ALSO save to global location for ESP8266 compatibility
      const globalScheduleRef = ref(db, `Schedules/Sensor${sensorId + 1}`);
      await update(globalScheduleRef, {
        ...schedulesForFirebase,
        userEmail: user.email // ADDED: Identify which user's schedule this is
      });
      
      Alert.alert("Success", "Watering schedules saved successfully!\n\nPumps will run for 5 minutes when current time and day match your schedule.");
    } catch (error) {
      console.error("Error saving schedules:", error);
      Alert.alert("Error", "Failed to save schedules: " + error.message);
    }
  };

  useEffect(() => {
    if (!user) return;

    let unsubPlants;
    const unsubscribers = [];
    
    // Load user's devices
    const devicesRef = ref(db, `Users/${user.uid}/devices`);
    const unsubDevicesList = onValue(devicesRef, (snapshot) => {
      if (snapshot.exists()) {
        const devicesData = snapshot.val();
        setDevices(devicesData);
        
        const shouldDisplayData = shouldDisplaySensorData(devicesData);
        
        if (shouldDisplayData) {
          // Subscribe to sensor data (public)
          for (let i = 0; i < 4; i++) {
            const sensorRef = ref(db, `Sensor${i + 1}`);
            const unsubscribe = onValue(sensorRef, (snapshot) => {
              if (snapshot.exists()) {
                const value = snapshot.val();
                console.log(`Sensor${i + 1} value:`, value);
                
                setSoilMoisture((prev) => {
                  const newMoisture = [...prev];
                  newMoisture[i] = value;
                  return newMoisture;
                });
                
                // CHECK FOR MOISTURE CHANGES AND SEND NOTIFICATIONS
                if (notificationEnabled && plants[i] && value !== null) {
                  // Check for significant changes
                  moistureNotifier.checkMoistureChange(i, value, plants[i].name);
                  
                  // Check for critical levels
                  moistureNotifier.checkCriticalMoisture(i, value, plants[i].name);
                }
                
                updateHistory(i, value);
              } else {
                setSoilMoisture((prev) => {
                  const newMoisture = [...prev];
                  newMoisture[i] = null;
                  return newMoisture;
                });
              }
            });
            unsubscribers.push(unsubscribe);
          }

          const pumpRef = ref(db, "PumpState");
          const pumpUnsubscribe = onValue(pumpRef, (snapshot) => {
            if (snapshot.exists()) {
              console.log("Pump state:", snapshot.val());
            }
          });
          unsubscribers.push(pumpUnsubscribe);
        } else {
          setSoilMoisture(Array(4).fill(null));
        }
      } else {
        setDevices({});
        setSoilMoisture(Array(4).fill(null));
      }
    });

    if (device) {
      setRegisteredDevice(device);
    } else {
      // Use user-specific device reference
      const deviceRef = ref(db, `Users/${user.uid}/devices/device1`);
      const unsubDevice = onValue(deviceRef, (snapshot) => {
        if (snapshot.exists()) {
          setRegisteredDevice(snapshot.val());
        } else {
          setRegisteredDevice(null);
        }
      });
      unsubscribers.push(unsubDevice);
    }

    // Load user's plants
    const plantsRef = ref(db, `Users/${user.uid}/plants`);
    unsubPlants = onValue(plantsRef, (snapshot) => {
      if (snapshot.exists()) {
        const raw = snapshot.val();
        const arr = Array(4).fill(null);
        for (let i = 0; i < 4; i++) {
          if (raw?.[i]) arr[i] = raw[i];
        }
        setPlants(arr);
      } else {
        setPlants(Array(4).fill(null));
      }
    });

    return () => {
      if (unsubPlants) unsubPlants();
      if (unsubDevicesList) unsubDevicesList();
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [user, device, notificationEnabled, plants]);

  // ADDED: Updated schedule checking useEffect
  useEffect(() => {
    const checkSchedules = async () => {
      // ADDED: User validation
      if (!user || !user.uid) {
        console.log("No user authenticated, skipping schedule check");
        return;
      }

      const now = new Date();
      const currentDay = now.getDay();
      const currentHour = now.getHours();
      const currentMinute = now.getMinutes();
      
      console.log(`Checking schedules for user ${user.uid} at ${currentHour}:${currentMinute} on day ${currentDay}`);

      for (let sensorIndex = 0; sensorIndex < 4; sensorIndex++) {
        try {
          const schedules = await loadSchedules(sensorIndex, user.uid);
          
          for (const schedule of schedules) {
            if (schedule.enabled && 
                schedule.hour === currentHour && 
                schedule.minute === currentMinute) {
              
              const dayMask = 1 << currentDay;
              const isDayEnabled = (schedule.days & dayMask) !== 0;
              
              if (isDayEnabled) {
                console.log(`Schedule match found for User ${user.uid} - Sensor ${sensorIndex + 1} on day ${currentDay}`);
                
                const success = await controlPump(sensorIndex, "ON");
                if (success) {
                  console.log(`Pump activated for Sensor ${sensorIndex + 1}`);
                  
                  setTimeout(async () => {
                    await controlPump(sensorIndex, "OFF");
                    console.log(`Pump deactivated for Sensor ${sensorIndex + 1}`);
                  }, 300000);
                }
              }
            }
          }
        } catch (error) {
          console.error(`Error checking schedules for sensor ${sensorIndex}:`, error);
        }
      }
    };

    const scheduleInterval = setInterval(checkSchedules, 60000);
    checkSchedules();

    return () => {
      clearInterval(scheduleInterval);
    };
  }, [user?.uid]); // ADDED: Dependency on user.uid

  const updateHistory = (sensorIndex, value) => {
    const status = value >= 800 ? "Dry" : value >= 400 ? "Moist" : "Wet";
    const timestamp = new Date().toLocaleString();

    setHistory((prev) => {
      const newHistory = prev.map((h) => Array.isArray(h) ? [...h] : []);
      if (!Array.isArray(newHistory[sensorIndex])) newHistory[sensorIndex] = [];
      
      newHistory[sensorIndex] = [
        { status, timestamp, value }, 
        ...newHistory[sensorIndex].slice(0, 9)
      ];
      
      return newHistory;
    });
  };

  const handleRegisterPlant = (sensorId, plantName) => {
    const idx = sensorId;
    const newPlantObj = {
      name: plantName,
      sensorId: idx + 1,
      registeredAt: new Date().toISOString(),
      userId: user.uid
    };

    setPlants((prev) => {
      const copy = [...prev];
      copy[idx] = newPlantObj;
      return copy;
    });

    update(ref(db), {
      [`Users/${user.uid}/plants/${idx}`]: newPlantObj,
    })
      .then(() => {})
      .catch((err) => {
        Alert.alert("Error", "Could not save plant: " + err.message);
      });
  };

  const handlePlantPress = async (sensorIndex) => {
    if (!registeredDevice) {
      Alert.alert("No device", "Register a device first in the Device screen.");
      return;
    }
    
    if (plants[sensorIndex]) {
      setSelectedSensor(sensorIndex);
      setSelectedPlant(plants[sensorIndex]);
      
      try {
        console.log("Loading schedules for sensor:", sensorIndex);
        const existingSchedules = await loadSchedules(sensorIndex, user?.uid);
        console.log("Loaded schedules:", existingSchedules);
        setSelectedSchedules(existingSchedules);
        
        setActionModalConfig({
          title: plants[sensorIndex].name,
          message: "Choose an action",
          actions: [
            { text: "View Details", onPress: () => setDetailsModalVisible(true) },
            { text: "Set Schedule", onPress: () => setScheduleModalVisible(true) },
            { text: "Rename", onPress: () => setRenameModalVisible(true) },
            { text: "Cancel", style: "cancel" },
          ]
        });
        setActionModalVisible(true);
      } catch (error) {
        console.error("Error handling plant press:", error);
        Alert.alert("Error", "Could not load schedules");
      }
    } else {
      setSelectedSensor(sensorIndex);
      setRegistrationModalVisible(true);
    }
  };

  const handleRenamePlant = (newName) => {
    const idx = selectedSensor;
    if (idx === null || idx === undefined) return;

    const updatedPlant = { ...plants[idx], name: newName, updatedAt: new Date().toISOString() };

    setPlants((prev) => {
      const copy = [...prev];
      copy[idx] = updatedPlant;
      return copy;
    });

    update(ref(db), { [`Users/${user.uid}/plants/${idx}`]: updatedPlant })
      .then(() => {
        setRenameModalVisible(false);
        setDetailsModalVisible(false);
        Alert.alert("Renamed", "Plant renamed successfully");
      })
      .catch((err) => {
        Alert.alert("Error", "Could not rename plant: " + err.message);
      });
  };

  const handleDeletePlant = (sensorIndex) => {
    if (sensorIndex === null || sensorIndex === undefined) return;

    Alert.alert(
      "Delete Plant",
      "Are you sure you want to delete this plant?",
      [
        { text: "Cancel", style: "cancel" },
        { 
          text: "Delete", 
          style: "destructive", 
          onPress: () => {
            const copy = [...plants];
            copy[sensorIndex] = null;
            setPlants(copy);

            update(ref(db), { [`Users/${user.uid}/plants/${sensorIndex}`]: null })
              .then(() => {
                setDetailsModalVisible(false);
                Alert.alert("Deleted", "Plant removed successfully.");
              })
              .catch((err) => {
                Alert.alert("Error", "Could not delete plant: " + err.message);
              });
          }
        },
      ]
    );
  };

  const renderPlantItem = (sensorIndex) => {
    const plant = plants[sensorIndex];
    const moistureValue = soilMoisture[sensorIndex];
    const isSensor3 = sensorIndex === 2;

    const bg = plant ? styles.registeredPlant : { 
      backgroundColor: "rgba(255,255,255,0.9)", 
      borderRadius: 15, 
      padding: 15, 
      alignItems: "center", 
      justifyContent: "center", 
      height: 120, 
      width: '100%',
      shadowColor: "#2E7D32", 
      shadowOffset: { width: 0, height: 2 }, 
      shadowOpacity: 0.2, 
      shadowRadius: 4, 
      elevation: 3 
    };

    return ( 
      <TouchableOpacity
        key={sensorIndex}
        style={[styles.plantItem]}
        onPress={() => handlePlantPress(sensorIndex)}
        onLongPress={() => {
          if (plants[sensorIndex]) {
            setSelectedSensor(sensorIndex);
            setSelectedPlant(plants[sensorIndex]);
            handleDeletePlant(sensorIndex);
          } else {
            setSelectedSensor(sensorIndex);
            setRegistrationModalVisible(true);
          }
        }}
      >
        {plant ? (
          <View style={bg}>
            <Text style={styles.plantName}>{plant.name}</Text>
            <Text style={styles.sensorId}>
              {isSensor3 ? "Connected to water pump" : `Connected to Sensor ${sensorIndex + 1}`}
            </Text>
            {!isSensor3 && (
              <Text style={styles.sensorValue}>
                {moistureValue !== null ? `Moisture: ${moistureValue}` : "No data"}
              </Text>
            )}
            <View
              style={[
                styles.statusIndicator,
                {
                  backgroundColor:
                    isSensor3 ? "#FF9800" : // Orange for Sensor 3
                    moistureValue === null
                      ? "#9E9E9E"
                      : moistureValue >= 800
                      ? "#FF5722"
                      : moistureValue >= 400
                      ? "#4CAF50"
                      : "#2196F3",
                },
              ]}
            />
          </View>
        ) : (
          <View style={bg}>
            <Text style={styles.plusText}>+</Text>
            <Text style={styles.plantText}>
              {isSensor3 ? "Exclusive for Dry Plants" : "Add Plant"}
            </Text>
            <Text style={styles.sensorId}>
              {isSensor3 ? "Activate" : `Sensor ${sensorIndex + 1}`}
            </Text>
          </View>
        )}
      </TouchableOpacity>
    );
  };

  // Plant Guide Modal Component
  const PlantGuideModal = ({ visible, onClose, plantData, currentIndex, onNext, onPrev }) => {
    const plant = plantData[currentIndex];
    
    return (
      <Modal animationType="slide" transparent={true} visible={visible} onRequestClose={onClose}>
        <View style={styles.plantGuideModalContainer}>
          <View style={styles.plantGuideModalContent}>
            <View style={styles.plantGuideHeader}>
              <Text style={styles.plantGuideTitle}>Plant Care Guide</Text>
              <TouchableOpacity onPress={onClose} style={styles.plantGuideCloseButton}>
                <Text style={styles.plantGuideCloseText}>✕</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.plantGuideCard}>
              <Text style={styles.plantGuideEmoji}>{plant.emoji}</Text>
              <Text style={styles.plantGuideNumber}>{plant.id}/10</Text>
              <Text style={styles.plantGuideName}>{plant.name}</Text>
              <Text style={styles.plantGuideDescription}>{plant.description}</Text>
              
              <View style={styles.wateringInfo}>
                <Text style={styles.wateringLabel}>💧 Watering:</Text>
                <Text style={styles.wateringSchedule}>{plant.watering}</Text>
              </View>
            </View>

            <View style={styles.plantGuideNavigation}>
              <TouchableOpacity 
                style={styles.navButton} 
                onPress={onPrev}
                disabled={currentIndex === 0}
              >
                <Text style={[styles.navButtonText, currentIndex === 0 && styles.disabledNavButton]}>
                  ← Previous
                </Text>
              </TouchableOpacity>

              <Text style={styles.pageIndicator}>
                {currentIndex + 1} / {plantData.length}
              </Text>

              <TouchableOpacity 
                style={styles.navButton} 
                onPress={onNext}
                disabled={currentIndex === plantData.length - 1}
              >
                <Text style={[styles.navButtonText, currentIndex === plantData.length - 1 && styles.disabledNavButton]}>
                  Next →
                </Text>
              </TouchableOpacity>
            </View>

            <TouchableOpacity 
              style={styles.plantGuideCloseMainButton}
              onPress={onClose}
            >
              <Text style={styles.plantGuideCloseMainText}>Close Guide</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  };

  return (
    <View style={[styles.container, styles.plantsBg]}>
      <LeafDecoration style={{ top: 90, left: 10 }} rotation="-20deg" />
      <SmallLeaf style={{ top: 140, right: 20 }} rotation="40deg" />
      <SmallLeaf style={{ bottom: 160, left: 30 }} rotation="-30deg" />
      <LeafDecoration style={{ bottom: 110, right: 10 }} rotation="60deg" />

      <Text style={styles.title}>
        {device ? `${device.name} Sensors` : "Plant Health Dashboard"}
      </Text>

      {!registeredDevice || !shouldDisplaySensorData(devices) ? (
        <View style={[styles.recommendationsContainer, { marginTop: 20 }]}>
          <Text style={styles.recommendationsTitle}>
            {!registeredDevice ? "No Device Registered" : "Access Restricted"}
          </Text>
          <Text style={styles.recommendationText}>
            {!registeredDevice 
              ? "Please register your ESP8266 device in the Device screen first." 
              : `Sensor data is only available from devices with IP: ${ALLOWED_IP}\n\nRegistered devices: ${Object.values(devices).map(d => d.ip).join(', ') || 'None'}`
            }
          </Text>

          <TouchableOpacity style={[styles.button, { marginTop: 12 }]} onPress={() => navigation.navigate("Selection", { user })}>
            <Text style={styles.buttonText}>Go to Device Screen</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.mainContent}>
          <ScrollView 
            contentContainerStyle={styles.plantsGridCentered}
            showsVerticalScrollIndicator={false}
          >
            {renderPlantItem(0)}
            {renderPlantItem(1)}
            {renderPlantItem(2)}
            {renderPlantItem(3)}
          </ScrollView>
          
          {/* NOTIFICATION TOGGLE BUTTON */}
          <TouchableOpacity 
            style={[
              styles.notificationToggleButton,
              { backgroundColor: notificationEnabled ? "#4CAF50" : "#9E9E9E" }
            ]}
            onPress={() => toggleNotifications(!notificationEnabled)}
          >
            <Text style={styles.notificationToggleButtonText}>
              {notificationEnabled ? "🔔 Notifications ON" : "🔕 Notifications OFF"}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <ScheduleModal
        visible={scheduleModalVisible}
        onClose={() => setScheduleModalVisible(false)}
        onSave={handleSaveSchedules}
        sensorId={selectedSensor}
        plantName={selectedPlant?.name}
        existingSchedules={selectedSchedules}
      />

      <PlantDetailsModal
        visible={detailsModalVisible}
        onClose={() => setDetailsModalVisible(false)}
        plant={selectedPlant}
        moistureData={selectedSensor !== null ? soilMoisture[selectedSensor] : null}
        onRenameRequest={() => {
          setDetailsModalVisible(false);
          setTimeout(() => setRenameModalVisible(true), 250);
        }}
        onScheduleRequest={async () => {
          setDetailsModalVisible(false);
          const existingSchedules = await loadSchedules(selectedSensor, user?.uid);
          setSelectedSchedules(existingSchedules);
          setTimeout(() => setScheduleModalVisible(true), 250);
        }}
        onShowHistory={() => {
          setDetailsModalVisible(false);
          setTimeout(() => setHistoryModalVisible(true), 250);
        }}
        sensorId={selectedSensor}
        userId={user?.uid}
      />

      <HistoryModal
        visible={historyModalVisible}
        onClose={() => setHistoryModalVisible(false)}
        history={selectedSensor !== null ? history[selectedSensor] : []}
      />

      <PlantRegistrationModal 
        visible={registrationModalVisible} 
        onClose={() => setRegistrationModalVisible(false)} 
        onRegister={handleRegisterPlant} 
        sensorId={selectedSensor ?? 0} 
      />

      <RenameModal 
        visible={renameModalVisible} 
        onClose={() => setRenameModalVisible(false)} 
        onRename={handleRenamePlant} 
        currentName={selectedPlant?.name} 
      />
      
      <ActionModal
        visible={actionModalVisible}
        onClose={() => setActionModalVisible(false)}
        title={actionModalConfig.title}
        message={actionModalConfig.message}
        actions={actionModalConfig.actions}
      />

      <ConfirmationModal
        visible={confirmModalVisible}
        onClose={() => setConfirmModalVisible(false)}
        title={confirmModalConfig.title}
        message={confirmModalConfig.message}
        onConfirm={confirmModalConfig.onConfirm}
      />

      {/* PLANT GUIDE MODAL */}
      <PlantGuideModal
        visible={plantGuideModalVisible}
        onClose={() => setPlantGuideModalVisible(false)}
        plantData={plantGuideData}
        currentIndex={currentPlantIndex}
        onNext={nextPlant}
        onPrev={prevPlant}
      />
    </View>
  );
};

// Main App Component with Authentication
export default function App() {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Clear any stale OTP data on app start
    AsyncStorage.removeItem('otpData');
    
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsLoading(false);
    });

    return unsubscribe;
  }, []);

  if (isLoading) {
    return (
      <View style={[styles.container, styles.welcomeBg]}>
        <Text style={styles.title}>PAWS</Text>
        <Text style={styles.subtitle}>Loading...</Text>
      </View>
    );
  }

  return (
    <NavigationContainer>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {!user ? (
          <Stack.Screen name="Login" component={LoginScreen} />
        ) : (
          <>
            <Stack.Screen 
              name="Selection" 
              component={SelectionScreen}
              initialParams={{ user }}
            />
            <Stack.Screen 
              name="Plants" 
              component={PlantsScreen}
              initialParams={{ user }}
            />
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Styles (keep all your existing styles - they remain the same)
const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  welcomeBg: { backgroundColor: "#E8F5E9" },
  selectionBg: { backgroundColor: "#F1F8E9" },
  plantsBg: { backgroundColor: "#E8F5E9" },
  title: { fontSize: 32, fontWeight: "bold", marginBottom: 10, marginTop: 95, color: "#2E7D32", textAlign: "center" },
  subtitle: { fontSize: 16, color: "#388E3C", marginBottom: 20, textAlign: "center" },
  button: { backgroundColor: "#4CAF50", paddingVertical: 15, paddingHorizontal: 40, borderRadius: 30, marginVertical: 10, width: "80%", alignItems: "center", shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 5 },
  buttonText: { color: "white", fontSize: 18, fontWeight: "bold" },
  disabledButton: { backgroundColor: '#9E9E9E', opacity: 0.6 },
  authContainer: { width: '100%', paddingHorizontal: 20, marginTop: 30 },
  userHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%', paddingHorizontal: 20, marginBottom: 10, marginTop: 10 },
  welcomeText: { fontSize: 16, color: '#2E7D32', fontWeight: '500' },
  logoutButton: { backgroundColor: '#FF5722', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20 },
  logoutButtonText: { color: 'white', fontSize: 14, fontWeight: '500' },
  input: { height: 50, width: "100%", borderColor: "#4CAF50", borderWidth: 1, borderRadius: 10, paddingHorizontal: 15, marginBottom: 20, fontSize: 16 },
  modalContainer: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0, 0, 0, 0.5)" },
  modalContent: { backgroundColor: "white", borderRadius: 20, padding: 20, width: "85%", alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5 },
  modalTitle: { fontSize: 20, fontWeight: "bold", color: "#2E7D32", marginBottom: 10 },
  modalSubtitle: { fontSize: 16, color: "#388E3C", marginBottom: 20, textAlign: "center" },
  modalButtons: { flexDirection: "row", justifyContent: "space-between", width: "100%" },
  modalButton: { flex: 1, padding: 15, borderRadius: 10, alignItems: "center", marginHorizontal: 5 },
  cancelButton: { backgroundColor: "#E8F5E9", borderWidth: 1, borderColor: "#4CAF50" },
  connectButton: { backgroundColor: "#4CAF50" },
  cancelButtonText: { color: "#2E7D32", fontWeight: "bold" },
  connectButtonText: { color: "white", fontWeight: "bold" },
  leaf: { position: "absolute", width: 60, height: 60, opacity: 0.7 },
  leafText: { fontSize: 50, opacity: 0.6 },
  smallLeaf: { position: "absolute", width: 40, height: 40, opacity: 0.6 },
  smallLeafText: { fontSize: 30, opacity: 0.5 },
  
  // NEW: Login Frame Styles
  loginFrame: {
    backgroundColor: "white",
    borderRadius: 20,
    padding: 25,
    width: "90%",
    maxWidth: 400,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
    alignItems: "center",
    marginTop: 20,
  },
  
  // Device Grid Styles
  devicesGridCentered: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", width: "100%", paddingBottom: 20, paddingHorizontal: 10 },
  deviceSlot: { width: "44%", height: 110, backgroundColor: "rgba(255,255,255,0.7)", borderRadius: 12, padding: 10, alignItems: "center", justifyContent: "center", marginBottom: 12, margin: 6, borderWidth: 1, borderColor: "#4CAF50", borderStyle: "dashed" },
  registeredDevice: { backgroundColor: "white", borderStyle: "solid", shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
  deviceContent: { alignItems: "center", justifyContent: "center", width: "100%" },
  deviceName: { fontSize: 14, fontWeight: "bold", color: "#2E7D32", textAlign: "center", marginBottom: 3 },
  deviceIp: { fontSize: 12, color: "#388E3C", textAlign: "center", marginBottom: 3 },
  deviceDate: { fontSize: 9, color: "#757575", textAlign: "center" },
  addDeviceText: { fontSize: 14, color: "#2E7D32", fontWeight: "500", marginTop: 3 },
  plusText: { fontSize: 32, color: "#4CAF50", fontWeight: "bold" },
  slotText: { fontSize: 10, color: "#9E9E9E", marginTop: 3 },
  longPressInstruction: { fontSize: 14, color: "#FF9800", backgroundColor: "#FFF3E0", padding: 10, borderRadius: 8, marginBottom: 15, textAlign: "center", fontWeight: "500" },
  longPressHint: { fontSize: 8, color: "#FF5722", fontStyle: "italic", marginTop: 3, textAlign: "center" },
  
  // Plant Grid Styles
  plantsGridCentered: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", width: "100%", paddingBottom: 20, paddingHorizontal: 15, paddingTop: 10 },
  plantItem: { width: "45%", margin: '2.5%', alignItems: 'center', justifyContent: 'center' },
  registeredPlant: { backgroundColor: "white", borderRadius: 15, padding: 15, alignItems: "center", justifyContent: "center", height: 120, width: '100%', shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 },
  plantName: { fontSize: 18, fontWeight: "bold", color: "#2E7D32", textAlign: "center", marginBottom: 5 },
  sensorId: { fontSize: 12, color: "#757575", marginBottom: 10 },
  sensorValue: { fontSize: 14, color: "#757575", marginBottom: 5 },
  plantText: { fontSize: 16, color: "#2E7D32", fontWeight: "500", marginTop: 5 },
  statusIndicator: { width: 20, height: 20, borderRadius: 10 },
  
  // Recommendations Styles
  recommendationsContainer: { width: "100%", backgroundColor: "white", borderRadius: 15, padding: 20, shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3, marginTop: 15 },
  recommendationsTitle: { fontSize: 20, fontWeight: "bold", color: "#2E7D32", marginBottom: 15, textAlign: "center" },
  recommendationText: { fontSize: 16, color: "#388E3C", textAlign: "center", marginBottom: 10 },
  
  // OTP Modal Styles
  otpModalContainer: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0, 0, 0, 0.7)" },
  otpModalContent: { backgroundColor: "white", borderRadius: 20, padding: 25, width: "90%", maxWidth: 400, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 8 },
  otpHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20, paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: "#E0E0E0" },
  otpTitle: { fontSize: 22, fontWeight: "700", color: "#2E7D32" },
  otpCloseButton: { width: 32, height: 32, borderRadius: 16, backgroundColor: "#E8F5E9", alignItems: "center", justifyContent: "center" },
  otpCloseButtonText: { fontSize: 18, color: "#2E7D32", fontWeight: "bold" },
  otpSubtitle: { fontSize: 16, color: "#666", textAlign: "center", marginBottom: 5 },
  otpEmail: { fontSize: 16, fontWeight: "600", color: "#2E7D32", textAlign: "center", marginBottom: 25, backgroundColor: "#E8F5E9", padding: 10, borderRadius: 8 },
  otpInput: { height: 55, width: "100%", borderColor: "#4CAF50", borderWidth: 2, borderRadius: 12, paddingHorizontal: 20, marginBottom: 25, fontSize: 18, fontWeight: "600", textAlign: "center", letterSpacing: 8, backgroundColor: "#F9F9F9" },
  otpButtons: { flexDirection: "row", justifyContent: "space-between", gap: 12, marginBottom: 15 },
  otpButton: { flex: 1, paddingVertical: 14, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  resendButton: { backgroundColor: "#E8F5E9", borderWidth: 1, borderColor: "#4CAF50" },
  verifyButton: { backgroundColor: "#4CAF50", shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 3 },
  resendButtonText: { color: "#2E7D32", fontSize: 14, fontWeight: "600" },
  verifyButtonText: { color: "white", fontSize: 16, fontWeight: "600" },
  otpHint: { fontSize: 12, color: "#666", textAlign: "center", fontStyle: "italic", marginTop: 10 },
  otpAlternative: { fontSize: 14, color: "#666", textAlign: "center", marginTop: 20, padding: 10, backgroundColor: "#FFF3E0", borderRadius: 8 },
  
  // Add remaining styles as needed for other components...
  centeredModalContainer: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0, 0, 0, 0.5)" },
  improvedModalContent: { backgroundColor: "white", borderRadius: 20, padding: 20, alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5 },
  modalHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20, paddingBottom: 15, borderBottomWidth: 1, borderBottomColor: "#E0E0E0", width: "100%" },
  modalTitleLarge: { fontSize: 26, fontWeight: "700", color: "#2E7D32", marginBottom: 4 },
  modalSensorInfo: { fontSize: 14, color: "#999" },
  closeButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: "#E8F5E9", alignItems: "center", justifyContent: "center" },
  closeButtonText: { fontSize: 20, color: "#2E7D32", fontWeight: "bold" },
  
  // Add other specific component styles as needed...

  authContainer: {
    width: '100%',
    paddingHorizontal: 20,
    marginTop: 30,
  },
  userHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    paddingHorizontal: 20,
    marginBottom: 10,
    marginTop: 10,
  },
  welcomeText: {
    fontSize: 16,
    color: '#2E7D32',
    fontWeight: '500',
  },
  logoutButton: {
    backgroundColor: '#FF5722',
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 20,
  },
  logoutButtonText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '500',
  },
  disabledButton: {
    backgroundColor: '#9E9E9E',
    opacity: 0.6,
  },

devicesGrid: {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "space-around",
  alignItems: "flex-start",
  width: "100%",
  paddingBottom: 20,
},
// ADD THIS NEW STYLE:
devicesGridCentered: {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "center", // Changed from space-between
  alignItems: "center",
  width: "100%",
  paddingBottom: 20,
  paddingHorizontal: 10, // Add some padding on sides
},
deviceSlot: {
  width: "44%", // Reduced from 46% to 44%
  height: 110, // Reduced from 140 to 110
  backgroundColor: "rgba(255,255,255,0.7)",
  borderRadius: 12, // Reduced from 15 to 12
  padding: 10, // Reduced from 15 to 10
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 12, // Reduced from 15 to 12
  margin: 6, // Reduced from 8 to 6
  borderWidth: 1,
  borderColor: "#4CAF50",
  borderStyle: "dashed",
},
registeredDevice: {
  backgroundColor: "white",
  borderStyle: "solid",
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.2,
  shadowRadius: 4,
  elevation: 3,
},
deviceContent: {
  alignItems: "center",
  justifyContent: "center",
  width: "100%",
},
deviceName: {
  fontSize: 14, // Reduced from 16 to 14
  fontWeight: "bold",
  color: "#2E7D32",
  textAlign: "center",
  marginBottom: 3, // Reduced from 5 to 3
},
deviceIp: {
  fontSize: 12, // Reduced from 14 to 12
  color: "#388E3C",
  textAlign: "center",
  marginBottom: 3, // Reduced from 5 to 3
},
deviceDate: {
  fontSize: 9, // Reduced from 10 to 9
  color: "#757575",
  textAlign: "center",
},
addDeviceText: {
  fontSize: 14, // Reduced from 16 to 14
  color: "#2E7D32",
  fontWeight: "500",
  marginTop: 3, // Reduced from 5 to 3
},

  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 

  },
  welcomeBg: { backgroundColor: "#E8F5E9" 

  },
  selectionBg: { backgroundColor: "#F1F8E9" 

  },
  plantsBg: { backgroundColor: "#E8F5E9" 

  },
  button: { backgroundColor: "#4CAF50", paddingVertical: 15, paddingHorizontal: 40, borderRadius: 30, marginVertical: 10, width: "80%", alignItems: "center", shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 5 
},
  secondaryButton: { backgroundColor: "#8BC34A" 

  },
  buttonText: { color: "white", fontSize: 18, fontWeight: "bold" 

  },
  iconsContainer: { flexDirection: "row", justifyContent: "space-between", width: "100%", marginBottom: 40 

  },
  iconButton: { alignItems: "center" 

  },
  plusIconContainer: { width: 80, height: 80, borderRadius: 40, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", marginBottom: 10, shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3, borderWidth: 2, borderColor: "#4CAF50", position: "relative" 
},
  plusIcon: { width: 100, height: 100, borderRadius: 50, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", marginBottom: 10, borderWidth: 2, borderColor: "#4CAF50", borderStyle: "dashed", shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 4, elevation: 3 
},
  plusText: { fontSize: 32, color: "#4CAF50", fontWeight: "bold" }, // Reduced from 40 to 32

  microchipIcon: { fontSize: 36 

  },
  iconLabel: { fontSize: 16, color: "#2E7D32", fontWeight: "500", textAlign: "center" 

  },
  continueButton: { backgroundColor: "#388E3C", paddingVertical: 15, paddingHorizontal: 40, borderRadius: 30, width: "80%", alignItems: "center", shadowColor: "#2E7D32", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 5 
},
  continueButtonText: { color: "white", fontSize: 18, fontWeight: "bold" 

  },
  plantsContainer: { flexDirection: "row", justifyContent: "space-around", width: "100%", marginBottom: 40 

  },
  
  plantsGrid: {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "center", // Change from "space-between" to "center"
  width: "100%",
  paddingBottom: 20,
},
// ADD THIS NEW STYLE:
plantsGridCentered: {
  flexDirection: "row",
  flexWrap: "wrap",
  justifyContent: "center",
  alignItems: "center",
  width: "100%",
  paddingBottom: 20,
  paddingHorizontal: 15, // Add padding on sides
  paddingTop: 10, // Add some top padding
},
  plantItem: {
  width: "45%", // Slightly reduced width to allow for centering
  marginBottom: 15,
  marginHorizontal: "2.5%", // Add horizontal margin for spacing
   margin: 8,
},
  registeredPlant: {
    backgroundColor: "white",
    borderRadius: 15,
    padding: 15,
    alignItems: "center",
    justifyContent: "center",
    height: 120,
    width: '100%',
    shadowColor: "#2E7D32",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  plantName: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#2E7D32",
    textAlign: "center",
    marginBottom: 5,
  },
  sensorId: {
    fontSize: 12,
    color: "#757575",
    marginBottom: 10,
  },
  statusIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  plantText: { fontSize: 16, color: "#2E7D32", fontWeight: "500" },
  backButton: { position: "absolute", top: 50, right: 20, backgroundColor: "rgba(76, 175, 80, 0.2)", width: 50, height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: "#4CAF50" },
  backButtonText: { fontSize: 24, fontWeight: "bold", color: "#2E7D32" },
  leaf: { position: "absolute", width: 60, height: 60, opacity: 0.7 },
  leafText: { fontSize: 50, opacity: 0.6 },
  smallLeaf: { position: "absolute", width: 40, height: 40, opacity: 0.6 },
  smallLeafText: { fontSize: 30, opacity: 0.5 },
  modalContainer: { flex: 1, justifyContent: "center", alignItems: "center", backgroundColor: "rgba(0, 0, 0, 0.5)" },
  modalContent: { backgroundColor: "white", borderRadius: 20, padding: 20, width: "85%", alignItems: "center", shadowColor: "#000", shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5 },
  modalTitle: { fontSize: 20, fontWeight: "bold", color: "#2E7D32", marginBottom: 10 },
  modalSubtitle: { fontSize: 16, color: "#388E3C", marginBottom: 20, textAlign: "center" },
  input: { height: 50, width: "100%", borderColor: "#4CAF50", borderWidth: 1, borderRadius: 10, paddingHorizontal: 15, marginBottom: 20, fontSize: 16 },
  modalButtons: { flexDirection: "row", justifyContent: "space-between", width: "100%" },
  modalButton: { flex: 1, padding: 15, borderRadius: 10, alignItems: "center", marginHorizontal: 5 },
  cancelButton: { backgroundColor: "#E8F5E9", borderWidth: 1, borderColor: "#4CAF50" },
  connectButton: { backgroundColor: "#4CAF50" },
  cancelButtonText: { color: "#2E7D32", fontWeight: "bold" },
  connectButtonText: { color: "white", fontWeight: "bold" },
  soilValue: { fontSize: 40, fontWeight: "bold", color: "#2E7D32", marginTop: 20 },
  moistureLabel: { fontSize: 20, fontWeight: "bold", color: "#2E7D32", marginTop: 10 },

  // Dashboard styles
  dashboardContainer: { width: "100%", marginBottom: 20 },
  sensorRow: { flexDirection: "row", justifyContent: "space-between", marginBottom: 15 },
  sensorCard: {
    width: "48%",
    backgroundColor: "white",
    borderRadius: 15,
    padding: 15,
    alignItems: "center",
    shadowColor: "#2E7D32",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  sensorTitle: { fontSize: 16, color: "#2E7D32", fontWeight: "bold", marginBottom: 5 },
  sensorValue: { fontSize: 24, fontWeight: "bold", color: "#4CAF50" },
  sensorStatus: { fontSize: 14, color: "#757575", marginTop: 5 },

  // Recommendations styles
  recommendationsContainer: {
    width: "100%",
    backgroundColor: "white",
    borderRadius: 15,
    padding: 20,
    shadowColor: "#2E7D32",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
    marginTop: 15,
  },
  recommendationsTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#2E7D32",
    marginBottom: 15,
    textAlign: "center",
  },
  recommendationItem: {
    backgroundColor: "#E8F5E9",
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  recommendationText: {
    fontSize: 16,
    color: "#388E3C",
  },

  // Soil Moisture Indicator styles
  moistureIndicator: {
    width: "100%",
    backgroundColor: "white",
    borderRadius: 15,
    padding: 20,
    marginBottom: 20,
    shadowColor: "#2E7D32",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  moistureHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 15,
  },
  moistureTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#2E7D32",
  },
  moistureIcon: {
    fontSize: 24,
  },
  moistureBarContainer: {
    height: 20,
    backgroundColor: "#E0E0E0",
    borderRadius: 10,
    overflow: "hidden",
    marginBottom: 10,
  },
  moistureBar: {
    height: "100%",
    borderRadius: 10,
  },
  moistureInfo: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 10,
  },
  moistureLabel: {
    fontSize: 18,
    fontWeight: "bold",
  },
  moistureValue: {
    fontSize: 16,
    color: "#757575",
  },
  moistureScale: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  scaleLabel: {
    fontSize: 12,
    color: "#757575",
  },

plantsRow: {
  flexDirection: "row",
  justifyContent: "center",
  width: "100%",
  marginBottom: 15,
},

plantItem: {
  width: '45%',
  margin: '2.5%', // This will create equal spacing on all sides
  alignItems: 'center',
  justifyContent: 'center',
},

deleteIconContainer: {
  position: "absolute",
  top: 5,
  right: 5,
  backgroundColor: "#FF5722",
  width: 20,
  height: 20,
  borderRadius: 10,
  alignItems: "center",
  justifyContent: "center",
},
deleteIcon: {
  color: "white",
  fontSize: 12,
  fontWeight: "bold",
},
sensorValue: {
  fontSize: 14,
  color: "#757575",
  marginBottom: 5,
},
deleteHint: {
  fontSize: 12,
  color: "#757575",
  marginBottom: 10,
  fontStyle: "italic",
},

scheduleItem: {
  backgroundColor: '#F1F8E9',
  borderRadius: 10,
  padding: 15,
  marginBottom: 15,
  width: '100%',
},
scheduleHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10,
},
scheduleLabel: {
  fontSize: 16,
  fontWeight: 'bold',
  color: '#2E7D32',
},
timeInputContainer: {
  flexDirection: 'row',
  alignItems: 'center',
  marginBottom: 10,
},
timeInputs: {
  flexDirection: 'row',
  alignItems: 'center',
  marginLeft: 10,
},
timeInput: {
  width: 50,
  textAlign: 'center',
  marginHorizontal: 5,
},
durationContainer: {
  flexDirection: 'row',
  alignItems: 'center',
  marginBottom: 10,
},
durationInput: {
  width: 60,
  textAlign: 'center',
  marginLeft: 10,
},
daysContainer: {
  marginBottom: 10,
},
daysGrid: {
  flexDirection: 'row',
  flexWrap: 'wrap',
  marginTop: 5,
},
dayButton: {
  padding: 8,
  margin: 2,
  borderRadius: 5,
  backgroundColor: '#E8F5E9',
  borderWidth: 1,
  borderColor: '#4CAF50',
},
daySelected: {
  backgroundColor: '#4CAF50',
},
dayText: {
  fontSize: 12,
  color: '#2E7D32',
},
dayTextSelected: {
  color: 'white',
  fontWeight: 'bold',
},

// Add these to your styles
statusContainer: {
  width: '100%',
  backgroundColor: '#F8F9FA',
  borderRadius: 10,
  padding: 15,
  marginBottom: 15,
},
statusTitle: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginBottom: 10,
  textAlign: 'center',
},
statusRow: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 8,
},
statusLabel: {
  fontSize: 14,
  color: '#666',
  fontWeight: '500',
},
statusValue: {
  fontSize: 14,
  fontWeight: 'bold',
},
historyContainer: {
  width: '100%',
  backgroundColor: '#F8F9FA',
  borderRadius: 10,
  padding: 15,
  marginBottom: 15,
},
historyTitle: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginBottom: 10,
  textAlign: 'center',
},
historyList: {
  maxHeight: 150,
},
historyItem: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  backgroundColor: 'white',
  padding: 10,
  borderRadius: 8,
  marginBottom: 8,
  borderWidth: 1,
  borderColor: '#E0E0E0',
},
historyTime: {
  fontSize: 12,
  color: '#666',
  flex: 1,
},
historyDetails: {
  flexDirection: 'row',
  alignItems: 'center',
  flex: 1,
  justifyContent: 'flex-end',
},
historyStatus: {
  fontSize: 12,
  fontWeight: 'bold',
  marginRight: 8,
},
historyValue: {
  fontSize: 12,
  color: '#666',
  fontWeight: 'bold',
},
noHistoryText: {
  textAlign: 'center',
  color: '#666',
  fontStyle: 'italic',
  padding: 10,
},

plantsGrid: {
  flexDirection: 'row',
  flexWrap: 'wrap',
  justifyContent: 'center', // Changed from space-between to center
  alignItems: 'center',
  width: '100%',
  paddingBottom: 20,
},

registeredPlant: {
  backgroundColor: "white",
  borderRadius: 15,
  padding: 15,
  alignItems: "center",
  justifyContent: "center",
  height: 120,
  width: '100%', // Add this to ensure it takes full width of parent
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.2,
  shadowRadius: 4,
  elevation: 3,
},

  plantText: {
    fontSize: 16,
    color: "#2E7D32",
    fontWeight: "500",
    marginTop: 5,
  },
  sensorValue: {
    fontSize: 14,
    color: "#757575",
    marginBottom: 5,
  },
  statusIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  recommendationsContainer: {
    width: "100%",
    backgroundColor: "white",
    borderRadius: 15,
    padding: 20,
    shadowColor: "#2E7D32",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
    marginTop: 15,
  },
  recommendationsTitle: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#2E7D32",
    marginBottom: 15,
    textAlign: "center",
  },
  recommendationText: {
    fontSize: 16,
    color: "#388E3C",
    textAlign: "center",
    marginBottom: 10,
  },
  plantsRow: {
    flexDirection: "row",
    justifyContent: "center",
    width: "100%",
    marginBottom: 15,
  },
// Add these styles to your StyleSheet
historyModalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 20,
  width: "90%",
  maxHeight: "80%",
  alignItems: "center",
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.25,
  shadowRadius: 4,
  elevation: 5,
},
historyItem: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  backgroundColor: "white",
  padding: 10,
  borderRadius: 8,
  marginBottom: 8,
  borderWidth: 1,
  borderColor: "#E0E0E0",
  width: "100%",
},
historyTime: {
  fontSize: 12,
  color: "#666",
  flex: 1,
},
historyDetails: {
  flexDirection: "row",
  alignItems: "center",
  flex: 1,
  justifyContent: "flex-end",
},
historyStatus: {
  fontSize: 12,
  fontWeight: "bold",
  marginRight: 8,
},
historyValue: {
  fontSize: 12,
  color: "#666",
  fontWeight: "bold",
},
noHistoryText: {
  textAlign: "center",
  color: "#666",
  fontStyle: "italic",
  padding: 20,
},

slotText: {
  fontSize: 10, // Reduced from 12 to 10
  color: "#9E9E9E",
  marginTop: 3, // Reduced from 5 to 3
},

// Add these styles to your StyleSheet
longPressInstruction: {
  fontSize: 14,
  color: "#FF9800",
  backgroundColor: "#FFF3E0",
  padding: 10,
  borderRadius: 8,
  marginBottom: 15,
  textAlign: "center",
  fontWeight: "500",
},
longPressHint: {
  fontSize: 8, // Reduced from 10 to 8
  color: "#FF5722",
  fontStyle: "italic",
  marginTop: 3, // Reduced from 5 to 3
  textAlign: "center",
},

// Add these styles to your StyleSheet
centeredModalContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.5)",
},
modalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 20,
  alignItems: "center",
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.25,
  shadowRadius: 4,
  elevation: 5,
},
// ADD THESE NEW STYLES HERE ↓↓↓
actionModalContainer: {
  flex: 1,
  justifyContent: 'center',
  alignItems: 'center',
  backgroundColor: 'rgba(0, 0, 0, 0.6)',
},
actionModalContent: {
  backgroundColor: 'white',
  borderRadius: 20,
  padding: 25,
  width: '85%',
  maxWidth: 400,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
},
actionModalTitle: {
  fontSize: 22,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginBottom: 12,
  textAlign: 'center',
},
actionModalMessage: {
  fontSize: 16,
  color: '#666',
  marginBottom: 20,
  textAlign: 'center',
  lineHeight: 22,
},
actionButtonsContainer: {
  width: '100%',
},
actionButton: {
  backgroundColor: '#4CAF50',
  paddingVertical: 14,
  paddingHorizontal: 20,
  borderRadius: 12,
  marginBottom: 10,
  alignItems: 'center',
  shadowColor: '#2E7D32',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.2,
  shadowRadius: 3,
  elevation: 3,
},
actionButtonCancel: {
  backgroundColor: '#E8F5E9',
  borderWidth: 1,
  borderColor: '#4CAF50',
},
actionButtonDestructive: {
  backgroundColor: '#FF5722',
},
actionButtonText: {
  color: 'white',
  fontSize: 16,
  fontWeight: '600',
},
actionButtonTextCancel: {
  color: '#2E7D32',
},
actionButtonTextDestructive: {
  color: 'white',
},
actionButtonTextDestructive: {
  color: 'white',
},
// ADD THESE NEW STYLES ↓↓↓
confirmationButtonsRow: {
  flexDirection: 'row',
  width: '100%',
  justifyContent: 'space-between',
  marginTop: 10,
},
confirmationButton: {
  flex: 1,
  paddingVertical: 14,
  paddingHorizontal: 20,
  borderRadius: 12,
  alignItems: 'center',
  marginHorizontal: 5,
},
confirmationCancelButton: {
  backgroundColor: '#E8F5E9',
  borderWidth: 1,
  borderColor: '#4CAF50',
},
confirmationDeleteButton: {
  backgroundColor: '#FF5722',
},
confirmationCancelText: {
  color: '#2E7D32',
  fontSize: 16,
  fontWeight: '600',
},
confirmationDeleteText: {
  color: 'white',
  fontSize: 16,
  fontWeight: '600',
},
// NEW STYLES - Add to your existing styles object:

improvedModalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 20,
  alignItems: "center",
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.25,
  shadowRadius: 4,
  elevation: 5,
},

modalHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 20,
  paddingBottom: 15,
  borderBottomWidth: 1,
  borderBottomColor: "#E0E0E0",
  width: "100%",
},

modalTitleLarge: {
  fontSize: 26,
  fontWeight: "700",
  color: "#2E7D32",
  marginBottom: 4,
},

modalSensorInfo: {
  fontSize: 14,
  color: "#999",
},

closeButton: {
  width: 36,
  height: 36,
  borderRadius: 18,
  backgroundColor: "#E8F5E9",
  alignItems: "center",
  justifyContent: "center",
},

closeButtonText: {
  fontSize: 20,
  color: "#2E7D32",
  fontWeight: "bold",
},

sectionCard: {
  width: "100%",
  borderRadius: 14,
  padding: 16,
  marginBottom: 16,
},

sectionLabel: {
  fontSize: 14,
  fontWeight: "600",
  color: "#2E7D32",
  marginBottom: 12,
  textTransform: "uppercase",
  letterSpacing: 0.5,
},



closeModalButton: {
  width: "100%",
  paddingVertical: 14,
  borderRadius: 12,
  alignItems: "center",
  justifyContent: "center",
  backgroundColor: "#E8F5E9",
  borderWidth: 1,
  borderColor: "#4CAF50",
  marginTop: 12,
},

closeModalText: {
  fontSize: 16,
  fontWeight: "600",
  color: "#2E7D32",
},deviceActionModalContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.6)",
},

deviceActionModalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 20,
  width: "90%",
  maxWidth: 400,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
},

deviceModalHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 16,
  paddingBottom: 12,
  borderBottomWidth: 1,
  borderBottomColor: "#E0E0E0",
},

deviceModalTitle: {
  fontSize: 22,
  fontWeight: "700",
  color: "#2E7D32",
  marginBottom: 4,
},

deviceModalSubtitle: {
  fontSize: 13,
  color: "#999",
},

statusBanner: {
  flexDirection: "row",
  alignItems: "center",
  paddingVertical: 10,
  paddingHorizontal: 12,
  borderRadius: 10,
  marginBottom: 16,
},

statusDot: {
  width: 8,
  height: 8,
  borderRadius: 4,
  marginRight: 8,
},

statusBannerText: {
  fontSize: 14,
  fontWeight: "600",
},

deviceInfoCard: {
  backgroundColor: "#F5F5F5",
  borderRadius: 12,
  padding: 14,
  marginBottom: 16,
},

infoRow: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
},

infoLabel: {
  fontSize: 13,
  color: "#666",
  fontWeight: "500",
},

infoValue: {
  fontSize: 13,
  fontWeight: "700",
  color: "#2E7D32",
},

deviceActionButtonPrimary: {
  backgroundColor: "#2196F3",
  paddingVertical: 16,
  borderRadius: 12,
  alignItems: "center",
  justifyContent: "center",
  marginBottom: 16,
  shadowColor: "#2196F3",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 4,
},

deviceActionButtonPrimaryText: {
  fontSize: 16,
  fontWeight: "700",
  color: "white",
},

disabledText: {
  fontSize: 12,
  color: "rgba(255,255,255,0.8)",
  marginTop: 4,
  fontStyle: "italic",
},

deviceActionButtonsRow: {
  flexDirection: "row",
  justifyContent: "space-between",
  gap: 10,
  marginBottom: 16,
},

deviceActionButtonSecondary: {
  flex: 1,
  paddingVertical: 12,
  borderRadius: 10,
  alignItems: "center",
  justifyContent: "center",
  borderWidth: 2,
  borderColor: "#E0E0E0",
  backgroundColor: "white",
},

deviceActionButtonSecondaryText: {
  fontSize: 20,
  marginBottom: 4,
},

deviceActionButtonSecondaryLabel: {
  fontSize: 12,
  fontWeight: "600",
  color: "#2E7D32",
},

deviceActionButtonDelete: {
  borderColor: "#FF5722",
},

deviceCloseButton: {
  paddingVertical: 12,
  borderRadius: 10,
  alignItems: "center",
  backgroundColor: "#E8F5E9",
  borderWidth: 1,
  borderColor: "#4CAF50",
},

deviceCloseButtonText: {
  fontSize: 15,
  fontWeight: "600",
  color: "#2E7D32",
},
//new view details plant style (if this works remove the long commented style)
// NEW Moisture styles
  moistureSectionCard: {
    backgroundColor: "#F0F9FF",
    borderLeftWidth: 4,
    borderLeftColor: "#2196F3",
  },

  moistureContentWrapper: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 16,
  },

  moistureLeft: {
    alignItems: "center",
    flex: 1,
  },

  moistureIcon: {
    fontSize: 48,
    marginBottom: 8,
  },

  moistureStatusLabel: {
    fontSize: 16,
    fontWeight: "700",
  },

  moistureRight: {
    flex: 1,
    alignItems: "center",
  },

  moistureNumber: {
    fontSize: 44,
    fontWeight: "800",
    color: "#2E7D32",
    lineHeight: 48,
  },

  moistureUnit: {
    fontSize: 12,
    color: "#999",
    marginTop: 2,
  },

  moistureBarContainer: {
    height: 28,
    backgroundColor: "rgba(0,0,0,0.08)",
    borderRadius: 14,
    overflow: "hidden",
    marginBottom: 16,
  },

  moistureBarFill: {
    height: "100%",
    borderRadius: 14,
  },

  moistureScaleContainer: {
    flexDirection: "row",
    justifyContent: "space-around",
  },

  scaleItem: {
    alignItems: "center",
  },

  scaleValue: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2E7D32",
    marginBottom: 2,
  },

  scaleLabel: {
    fontSize: 11,
    color: "#999",
    fontWeight: "500",
  },

  // NEW Details styles
  detailsSectionCard: {
    backgroundColor: "#F5F9F5",
    borderLeftWidth: 4,
    borderLeftColor: "#4CAF50",
  },

  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 12,
  },

  detailLeft: {
    flexDirection: "row",
    alignItems: "center",
    flex: 1,
    marginRight: 12,
  },

  detailIcon: {
    fontSize: 20,
    marginRight: 12,
  },

  detailLabel: {
    fontSize: 14,
    fontWeight: "600",
    color: "#2E7D32",
    marginBottom: 2,
  },

  detailSmallText: {
    fontSize: 11,
    color: "#999",
    marginTop: 2,
  },

  detailValue: {
    fontSize: 14,
    fontWeight: "700",
    color: "#2E7D32",
    textAlign: "right",
  },

  detailDivider: {
    height: 1,
    backgroundColor: "rgba(0,0,0,0.05)",
    marginVertical: 8,
  },

  // NEW Action button styles
  quickActionsSection: {
    width: "100%",
    marginBottom: 16,
  },

  primaryActionButton: {
    width: "100%",
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 14,
    backgroundColor: "#2196F3",
    flexDirection: "row",
    shadowColor: "#2196F3",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },

  primaryActionEmoji: {
    fontSize: 20,
    marginRight: 10,
  },

  primaryActionText: {
    fontSize: 16,
    fontWeight: "700",
    color: "white",
  },

  secondaryActionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },

  secondaryActionButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2.5,
    backgroundColor: "white",
  },

  secondaryActionEmoji: {
    fontSize: 18,
    marginBottom: 6,
  },

  secondaryActionLabel: {
    fontSize: 12,
  },


  timeLabel: {
  fontSize: 16,
  fontWeight: '500',
  marginBottom: 8,
  color: '#2E7D32',
},
hourMinuteContainer: {
  flexDirection: 'row',
  alignItems: 'center',
},
timeSeparator: {
  fontSize: 18,
  fontWeight: 'bold',
  marginHorizontal: 5,
  color: '#2E7D32',
},
periodPicker: {
  height: 50,
  width: 100,
  marginLeft: 10,
},
durationLabel: {
  fontSize: 16,
  fontWeight: '500',
  marginBottom: 8,
  color: '#2E7D32',
},
daysLabel: {
  fontSize: 16,
  fontWeight: '500',
  marginBottom: 8,
  color: '#2E7D32',
},
// Add these to your existing styles
periodContainer: {
  flexDirection: 'row',
  marginLeft: 10,
},
periodButton: {
  paddingHorizontal: 12,
  paddingVertical: 8,
  borderWidth: 1,
  borderColor: '#4CAF50',
  borderRadius: 5,
  marginHorizontal: 2,
},
periodButtonSelected: {
  backgroundColor: '#4CAF50',
},
periodButtonText: {
  color: '#4CAF50',
  fontSize: 14,
},
periodButtonTextSelected: {
  color: 'white',
  fontWeight: 'bold',
},
timeInputs: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
},
hourMinuteContainer: {
  flexDirection: 'row',
  alignItems: 'center',
},
timeSeparator: {
  fontSize: 18,
  fontWeight: 'bold',
  marginHorizontal: 5,
  color: '#2E7D32',
},
timeLabel: {
  fontSize: 16,
  fontWeight: '500',
  marginBottom: 8,
  color: '#2E7D32',
},
durationLabel: {
  fontSize: 16,
  fontWeight: '500',
  marginBottom: 8,
  color: '#2E7D32',
},
daysLabel: {
  fontSize: 16,
  fontWeight: '500',
  marginBottom: 8,
  color: '#2E7D32',
},

// Add these to your StyleSheet
timePickersContainer: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 10,
},
pickerWrapper: {
  alignItems: 'center',
  flex: 1,
},
pickerLabel: {
  fontSize: 14,
  color: '#666',
  marginBottom: 5,
  fontWeight: '500',
},
pickerContainer: {
  height: 120,
  width: '90%',
  backgroundColor: '#f5f5f5',
  borderRadius: 10,
  borderWidth: 1,
  borderColor: '#4CAF50',
},
picker: {
  height: 120,
  width: '100%',
},
pickerItem: {
  fontSize: 18,
  color: '#2E7D32',
  fontWeight: '500',
},
selectedTime: {
  fontSize: 16,
  fontWeight: 'bold',
  color: '#2E7D32',
  textAlign: 'center',
  marginTop: 10,
  backgroundColor: '#E8F5E9',
  padding: 8,
  borderRadius: 8,
},

// Add to your StyleSheet
timePickersContainer: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: 10,
  paddingHorizontal: 10,
},
pickerWrapper: {
  alignItems: 'center',
  flex: 1,
},
pickerLabel: {
  fontSize: 14,
  color: '#666',
  marginBottom: 5,
  fontWeight: '500',
},
pickerContainer: {
  height: 120,
  width: '100%',
  backgroundColor: '#f5f5f5',
  borderRadius: 10,
  borderWidth: 1,
  borderColor: '#4CAF50',
  overflow: 'hidden',
},
picker: {
  height: 120,
  width: '100%',
},
pickerItem: {
  fontSize: 18,
  color: '#2E7D32',
  fontWeight: '500',
  height: 120,
},
timeSeparator: {
  fontSize: 20,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginHorizontal: 5,
  marginTop: 30,
},
selectedTime: {
  fontSize: 16,
  fontWeight: 'bold',
  color: '#2E7D32',
  textAlign: 'center',
  marginTop: 10,
  backgroundColor: '#E8F5E9',
  padding: 8,
  borderRadius: 8,
},

// Add these to your StyleSheet
scheduleHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  marginBottom: 10,
  width: '100%',
},
warningText: {
  fontSize: 12,
  color: '#FF9800',
  textAlign: 'center',
  marginBottom: 20,
  backgroundColor: '#FFF3E0',
  padding: 8,
  borderRadius: 8,
  width: '100%',
},
scheduleCard: {
  backgroundColor: '#F8F9FA',
  borderRadius: 12,
  padding: 16,
  marginBottom: 16,
  borderWidth: 1,
  borderColor: '#E0E0E0',
},
scheduleCardHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
},
scheduleNumber: {
  fontSize: 16,
  fontWeight: 'bold',
  color: '#2E7D32',
},
switchContainer: {
  flexDirection: 'row',
  alignItems: 'center',
},
switchLabel: {
  fontSize: 12,
  color: '#666',
  marginRight: 8,
},
scheduleContent: {
  borderTopWidth: 1,
  borderTopColor: '#E0E0E0',
  paddingTop: 12,
},
timeSection: {
  marginBottom: 16,
},
sectionTitle: {
  fontSize: 14,
  fontWeight: '600',
  color: '#2E7D32',
  marginBottom: 10,
},
timePickersContainer: {
  flexDirection: 'row',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
},
pickerColumn: {
  flex: 1,
  alignItems: 'center',
},
pickerLabel: {
  fontSize: 12,
  color: '#666',
  marginBottom: 5,
  fontWeight: '500',
},
pickerWrapper: {
  height: 100,
  width: '90%',
  backgroundColor: 'white',
  borderRadius: 8,
  borderWidth: 1,
  borderColor: '#4CAF50',
  overflow: 'hidden',
},
picker: {
  height: 100,
  width: '100%',
},
timeSeparator: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginTop: 20,
},
selectedTime: {
  fontSize: 14,
  fontWeight: 'bold',
  color: '#2E7D32',
  textAlign: 'center',
  backgroundColor: '#E8F5E9',
  padding: 8,
  borderRadius: 6,
},
daysSection: {
  marginBottom: 8,
},
daysGrid: {
  flexDirection: 'row',
  justifyContent: 'space-between',
},
dayButton: {
  padding: 8,
  borderRadius: 6,
  backgroundColor: 'white',
  borderWidth: 1,
  borderColor: '#E0E0E0',
  minWidth: 40,
  alignItems: 'center',
},
daySelected: {
  backgroundColor: '#4CAF50',
  borderColor: '#4CAF50',
},
dayText: {
  fontSize: 12,
  color: '#666',
  fontWeight: '500',
},
dayTextSelected: {
  color: 'white',
  fontWeight: 'bold',
},
footerButtons: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  width: '100%',
  marginTop: 16,
  paddingTop: 16,
  borderTopWidth: 1,
  borderTopColor: '#E0E0E0',
},
footerButton: {
  flex: 1,
  paddingVertical: 12,
  borderRadius: 8,
  alignItems: 'center',
  marginHorizontal: 6,
},
cancelButton: {
  backgroundColor: '#F5F5F5',
  borderWidth: 1,
  borderColor: '#E0E0E0',
},
saveButton: {
  backgroundColor: '#4CAF50',
},
cancelButtonText: {
  color: '#666',
  fontWeight: '600',
},
saveButtonText: {
  color: 'white',
  fontWeight: '600',
},

daysHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 10,
},
daysQuickActions: {
  flexDirection: 'row',
},
quickActionButton: {
  paddingHorizontal: 12,
  paddingVertical: 6,
  backgroundColor: '#E8F5E9',
  borderRadius: 6,
  marginLeft: 8,
  borderWidth: 1,
  borderColor: '#4CAF50',
},
quickActionText: {
  fontSize: 12,
  color: '#2E7D32',
  fontWeight: '500',
},
daysHint: {
  fontSize: 12,
  color: '#666',
  fontStyle: 'italic',
  marginTop: 8,
  textAlign: 'center',
},

// Add these to your StyleSheet
autoModeSectionCard: {
  backgroundColor: "#FFF9E6",
  borderLeftWidth: 4,
  borderLeftColor: "#FFA000",
},

autoModeHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 8,
},

autoModeTextContainer: {
  flex: 1,
  marginRight: 12,
},

autoModeTitle: {
  fontSize: 16,
  fontWeight: "700",
  color: "#2E7D32",
  marginBottom: 4,
},

autoModeDescription: {
  fontSize: 12,
  color: "#666",
  lineHeight: 16,
},

autoModeHint: {
  fontSize: 12,
  color: "#FF9800",
  fontStyle: "italic",
  textAlign: "center",
  backgroundColor: "rgba(255, 152, 0, 0.1)",
  padding: 8,
  borderRadius: 6,
},

// Add these styles to your existing StyleSheet
otpModalContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
},
otpModalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 25,
  width: "90%",
  maxWidth: 400,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
},
otpHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 20,
  paddingBottom: 15,
  borderBottomWidth: 1,
  borderBottomColor: "#E0E0E0",
},
otpTitle: {
  fontSize: 22,
  fontWeight: "700",
  color: "#2E7D32",
},
otpCloseButton: {
  width: 32,
  height: 32,
  borderRadius: 16,
  backgroundColor: "#E8F5E9",
  alignItems: "center",
  justifyContent: "center",
},
otpCloseButtonText: {
  fontSize: 18,
  color: "#2E7D32",
  fontWeight: "bold",
},
otpSubtitle: {
  fontSize: 16,
  color: "#666",
  textAlign: "center",
  marginBottom: 5,
},
otpEmail: {
  fontSize: 16,
  fontWeight: "600",
  color: "#2E7D32",
  textAlign: "center",
  marginBottom: 25,
  backgroundColor: "#E8F5E9",
  padding: 10,
  borderRadius: 8,
},
otpInput: {
  height: 55,
  width: "100%",
  borderColor: "#4CAF50",
  borderWidth: 2,
  borderRadius: 12,
  paddingHorizontal: 20,
  marginBottom: 25,
  fontSize: 18,
  fontWeight: "600",
  textAlign: "center",
  letterSpacing: 8,
  backgroundColor: "#F9F9F9",
},
otpButtons: {
  flexDirection: "row",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 15,
},
otpButton: {
  flex: 1,
  paddingVertical: 14,
  borderRadius: 12,
  alignItems: "center",
  justifyContent: "center",
},
resendButton: {
  backgroundColor: "#E8F5E9",
  borderWidth: 1,
  borderColor: "#4CAF50",
},
verifyButton: {
  backgroundColor: "#4CAF50",
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 3,
},
resendButtonText: {
  color: "#2E7D32",
  fontSize: 14,
  fontWeight: "600",
},
verifyButtonText: {
  color: "white",
  fontSize: 16,
  fontWeight: "600",
},
otpHint: {
  fontSize: 12,
  color: "#666",
  textAlign: "center",
  fontStyle: "italic",
  marginTop: 10,
},
otpAlternative: {
  fontSize: 14,
  color: "#666",
  textAlign: "center",
  marginTop: 20,
  padding: 10,
  backgroundColor: "#FFF3E0",
  borderRadius: 8,
},

// Add to your styles object
otpModalContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
},
otpModalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 25,
  width: "90%",
  maxWidth: 400,
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
},
otpHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 20,
  paddingBottom: 15,
  borderBottomWidth: 1,
  borderBottomColor: "#E0E0E0",
},
otpTitle: {
  fontSize: 22,
  fontWeight: "700",
  color: "#2E7D32",
},
otpCloseButton: {
  width: 32,
  height: 32,
  borderRadius: 16,
  backgroundColor: "#E8F5E9",
  alignItems: "center",
  justifyContent: "center",
},
otpCloseButtonText: {
  fontSize: 18,
  color: "#2E7D32",
  fontWeight: "bold",
},
otpSubtitle: {
  fontSize: 16,
  color: "#666",
  textAlign: "center",
  marginBottom: 5,
},
otpEmail: {
  fontSize: 16,
  fontWeight: "600",
  color: "#2E7D32",
  textAlign: "center",
  marginBottom: 25,
  backgroundColor: "#E8F5E9",
  padding: 10,
  borderRadius: 8,
},
otpInput: {
  height: 55,
  width: "100%",
  borderColor: "#4CAF50",
  borderWidth: 2,
  borderRadius: 12,
  paddingHorizontal: 20,
  marginBottom: 25,
  fontSize: 18,
  fontWeight: "600",
  textAlign: "center",
  letterSpacing: 8,
  backgroundColor: "#F9F9F9",
},
otpButtons: {
  flexDirection: "row",
  justifyContent: "space-between",
  gap: 12,
  marginBottom: 15,
},
otpButton: {
  flex: 1,
  paddingVertical: 14,
  borderRadius: 12,
  alignItems: "center",
  justifyContent: "center",
},
resendButton: {
  backgroundColor: "#E8F5E9",
  borderWidth: 1,
  borderColor: "#4CAF50",
},
verifyButton: {
  backgroundColor: "#4CAF50",
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 3,
},
resendButtonText: {
  color: "#2E7D32",
  fontSize: 14,
  fontWeight: "600",
},
verifyButtonText: {
  color: "white",
  fontSize: 16,
  fontWeight: "600",
},
otpHint: {
  fontSize: 12,
  color: "#666",
  textAlign: "center",
  fontStyle: "italic",
  marginTop: 10,
},
otpAlternative: {
  fontSize: 14,
  color: "#666",
  textAlign: "center",
  marginTop: 20,
  padding: 10,
  backgroundColor: "#FFF3E0",
  borderRadius: 8,
},

// Add to your styles
demoOTPHint: {
  fontSize: 14,
  color: "#FF9800",
  textAlign: "center",
  marginTop: 10,
  padding: 10,
  backgroundColor: "#FFF3E0",
  borderRadius: 8,
  fontWeight: "600",
},
demoNotice: {
  fontSize: 12,
  color: "#FF5722",
  textAlign: "center",
  marginBottom: 10,
  padding: 8,
  backgroundColor: "#FFEBEE",
  borderRadius: 6,
  fontWeight: "600",
},

// Add these styles to your existing StyleSheet
otpButtonsContainer: {
  width: '100%',
  marginBottom: 15,
},
otpButton: {
  paddingVertical: 15,
  borderRadius: 12,
  alignItems: 'center',
  justifyContent: 'center',
  marginBottom: 12,
  width: '100%',
},
registerButton: {
  backgroundColor: '#4CAF50',
  shadowColor: '#2E7D32',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 5,
},
loginButton: {
  backgroundColor: '#2196F3',
  shadowColor: '#1976D2',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 5,
},
registerButtonText: {
  color: 'white',
  fontSize: 16,
  fontWeight: 'bold',
},
loginButtonText: {
  color: 'white',
  fontSize: 16,
  fontWeight: 'bold',
},
otpPurposeBadge: {
  backgroundColor: '#E3F2FD',
  paddingHorizontal: 12,
  paddingVertical: 6,
  borderRadius: 20,
  alignSelf: 'center',
  marginBottom: 15,
  borderWidth: 1,
  borderColor: '#2196F3',
},
otpPurposeText: {
  color: '#1976D2',
  fontSize: 12,
  fontWeight: '600',
},

// Add these updated styles to your StyleSheet
otpButtonsColumn: {
  width: '100%',
  marginBottom: 15,
},
otpButton: {
  paddingVertical: 14,
  borderRadius: 12,
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
},
verifyButton: {
  backgroundColor: "#4CAF50",
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 3,
  marginBottom: 12, // Space between green button and resend button
},
resendButton: {
  paddingVertical: 12,
  borderRadius: 12,
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  backgroundColor: "#E8F5E9",
  borderWidth: 1,
  borderColor: "#4CAF50",
},
verifyButtonText: {
  color: "white",
  fontSize: 16,
  fontWeight: "600",
},
resendButtonText: {
  color: "#2E7D32",
  fontSize: 14,
  fontWeight: "600",
},

// Add this new style to your StyleSheet
otpInputLabel: {
  fontSize: 16,
  fontWeight: '600',
  color: '#2E7D32',
  marginBottom: 8,
  textAlign: 'center',
  width: '100%',
},

// Add these new styles to your StyleSheet

// Bottom Navigation Bar
bottomNavBar: {
  flexDirection: 'row',
  backgroundColor: 'white',
  borderTopWidth: 1,
  borderTopColor: '#E0E0E0',
  paddingVertical: 12,
  paddingHorizontal: 20,
  width: '100%',
  justifyContent: 'space-around',
  shadowColor: '#000',
  shadowOffset: { width: 0, height: -2 },
  shadowOpacity: 0.1,
  shadowRadius: 3,
  elevation: 5,
},
navButton: {
  alignItems: 'center',
  justifyContent: 'center',
  paddingHorizontal: 15,
  paddingVertical: 8,
},
navButtonIcon: {
  fontSize: 20,
  marginBottom: 4,
},
navButtonText: {
  fontSize: 12,
  color: '#2E7D32',
  fontWeight: '500',
},

// Updated User Header
userInfo: {
  flex: 1,
},
emailText: {
  fontSize: 12,
  color: '#666',
  marginTop: 2,
},

// Settings Modal Styles
settingsSection: {
  width: '100%',
  marginBottom: 20,
},
settingsLabel: {
  fontSize: 16,
  fontWeight: '600',
  color: '#2E7D32',
  marginBottom: 8,
},
settingsHint: {
  fontSize: 12,
  color: '#666',
  marginTop: 4,
},
switchContainer: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
},
switchTextContainer: {
  flex: 1,
  marginRight: 15,
},


// Add these new styles for the slide-out drawer

// Drawer Styles
drawer: {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  width: 300,
  backgroundColor: 'white',
  zIndex: 1000,
  shadowColor: '#000',
  shadowOffset: { width: 2, height: 0 },
  shadowOpacity: 0.25,
  shadowRadius: 10,
  elevation: 10,
},
drawerContent: {
  flex: 1,
  paddingTop: 60,
  paddingHorizontal: 20,
},
drawerHeader: {
  paddingBottom: 20,
  borderBottomWidth: 1,
  borderBottomColor: '#E0E0E0',
  marginBottom: 20,
},
drawerWelcome: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginBottom: 5,
},
drawerEmail: {
  fontSize: 14,
  color: '#666',
},
drawerDivider: {
  height: 1,
  backgroundColor: '#E0E0E0',
  marginBottom: 20,
},
drawerItem: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingVertical: 15,
  paddingHorizontal: 10,
  borderRadius: 8,
  marginBottom: 10,
},
drawerItemIcon: {
  fontSize: 20,
  marginRight: 15,
  width: 24,
  textAlign: 'center',
},
drawerItemText: {
  fontSize: 16,
  color: '#2E7D32',
  fontWeight: '500',
},

// Menu Button
menuButton: {
  position: 'absolute',
  top: 50,
  left: 20,
  zIndex: 100,
  backgroundColor: 'white',
  width: 40,
  height: 40,
  borderRadius: 20,
  alignItems: 'center',
  justifyContent: 'center',
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.2,
  shadowRadius: 4,
  elevation: 5,
},
menuButtonIcon: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
},

// Overlay
overlay: {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  zIndex: 999,
},

// Add these new styles to your StyleSheet

// Drawer Styles
drawer: {
  position: 'absolute',
  top: 0,
  bottom: 0,
  width: 300,
  backgroundColor: 'white',
  zIndex: 1000,
  shadowColor: '#000',
  shadowOffset: { width: 2, height: 0 },
  shadowOpacity: 0.25,
  shadowRadius: 10,
  elevation: 10,
},
drawerContent: {
  flex: 1,
  paddingTop: 60,
  paddingHorizontal: 20,
},
drawerHeader: {
  paddingBottom: 20,
  borderBottomWidth: 1,
  borderBottomColor: '#E0E0E0',
  marginBottom: 20,
},
drawerWelcome: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
  marginBottom: 5,
},
drawerEmail: {
  fontSize: 14,
  color: '#666',
},
drawerDivider: {
  height: 1,
  backgroundColor: '#E0E0E0',
  marginBottom: 20,
},
drawerItem: {
  flexDirection: 'row',
  alignItems: 'center',
  paddingVertical: 15,
  paddingHorizontal: 10,
  borderRadius: 8,
  marginBottom: 10,
  backgroundColor: '#F8F9FA',
},
drawerItemIcon: {
  fontSize: 20,
  marginRight: 15,
  width: 24,
  textAlign: 'center',
},
drawerItemText: {
  fontSize: 16,
  color: '#2E7D32',
  fontWeight: '500',
},

// Menu Button
menuButton: {
  position: 'absolute',
  marginTop: '1.5%',
  top: 50,
  left: 20,
  zIndex: 100,
  backgroundColor: 'white',
  width: 40,
  height: 40,
  borderRadius: 20,
  alignItems: 'center',
  justifyContent: 'center',
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.2,
  shadowRadius: 4,
  elevation: 5,
},
menuButtonIcon: {
  fontSize: 18,
  fontWeight: 'bold',
  color: '#2E7D32',
},

// Overlay
overlay: {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.5)',
  zIndex: 999,
},

// Settings Modal Styles (if not already added)
settingsSection: {
  width: '100%',
  marginBottom: 20,
},
settingsLabel: {
  fontSize: 16,
  fontWeight: '600',
  color: '#2E7D32',
  marginBottom: 8,
},
settingsHint: {
  fontSize: 12,
  color: '#666',
  marginTop: 4,
},
switchContainer: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  width: '100%',
},
switchTextContainer: {
  flex: 1,
  marginRight: 15,
},


// Add these if they're missing from your styles
scheduleCardHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 12,
},
switchContainer: {
  flexDirection: 'row',
  alignItems: 'center',
},
switchLabel: {
  fontSize: 12,
  color: '#666',
  marginRight: 8,
},

sensor3Warning: {
  fontSize: 12,
  color: '#FF9800',
  textAlign: 'center',
  marginBottom: 15,
  backgroundColor: '#FFF3E0',
  padding: 8,
  borderRadius: 6,
},
// ADD THESE STYLES TO YOUR STYLESHEET:

professionalContainer: {
  width: '100%',
  backgroundColor: 'white',
  borderRadius: 12,
  padding: 16,
  marginBottom: 8,
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.1,
  shadowRadius: 4,
  elevation: 3,
  borderWidth: 1,
  borderColor: '#E0E0E0',
},
proHeader: {
  flexDirection: 'row',
  justifyContent: 'space-between',
  alignItems: 'center',
  marginBottom: 16,
},
proTitle: {
  fontSize: 16,
  fontWeight: '600',
  color: '#2E7D32',
},
proBadge: {
  backgroundColor: '#E8F5E9',
  paddingHorizontal: 10,
  paddingVertical: 4,
  borderRadius: 12,
  borderWidth: 1,
  borderColor: '#4CAF50',
},
proBadgeText: {
  fontSize: 12,
  color: '#2E7D32',
  fontWeight: '500',
},
// CENTERED GRID STYLES
proGrid: {
  flexDirection: 'row',
  justifyContent: 'center', // Changed from space-between to center
  marginBottom: 16,
  flexWrap: 'wrap', // Allow wrapping if needed
  gap: 4, // Add gap between items
},
dayColumn: {
  alignItems: 'center',
  marginHorizontal: 2, // Reduced margin
},
proDayCard: {
  alignItems: 'center',
  padding: 8,
  borderRadius: 10,
  backgroundColor: '#F8F9FA',
  borderWidth: 1,
  borderColor: '#E0E0E0',
  width: 44, // Fixed width
  height: 52, // Fixed height
  justifyContent: 'center',
},
proDayCardSelected: {
  backgroundColor: '#4CAF50',
  borderColor: '#4CAF50',
  shadowColor: '#4CAF50',
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 4,
},
weekendDay: {
  backgroundColor: '#FFF3E0',
  borderColor: '#FFB74D',
},
proDayShort: {
  fontSize: 14,
  fontWeight: 'bold',
  color: '#666',
  marginBottom: 2,
  textAlign: 'center',
},
proDayShortSelected: {
  color: 'white',
},
proDayFull: {
  fontSize: 10,
  color: '#999',
  textAlign: 'center',
  fontWeight: '500',
},
proDayFullSelected: {
  color: 'white',
  fontWeight: '600',
},
proSummary: {
  backgroundColor: '#F8F9FA',
  padding: 12,
  borderRadius: 8,
  marginBottom: 12,
  borderWidth: 1,
  borderColor: '#E0E0E0',
},
proSummaryText: {
  fontSize: 14,
  color: '#2E7D32',
  fontWeight: '500',
  textAlign: 'center',
},
// CENTERED QUICK ACTIONS
proQuickActions: {
  flexDirection: 'row',
  flexWrap: 'wrap',
  justifyContent: 'center', // Changed to center
  gap: 8,
},
proQuickButton: {
  paddingVertical: 8,
  paddingHorizontal: 12,
  backgroundColor: '#2196F3',
  borderRadius: 6,
  alignItems: 'center',
  minWidth: 70, // Minimum width
  flex: 0, // Remove flex to prevent stretching
  shadowColor: '#2196F3',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.2,
  shadowRadius: 2,
  elevation: 2,
},
proQuickButtonClear: {
  backgroundColor: 'transparent',
  borderWidth: 1,
  borderColor: '#FF5722',
  shadowColor: '#FF5722',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.2,
  shadowRadius: 2,
  elevation: 2,
},
proQuickButtonText: {
  fontSize: 11,
  color: 'white',
  fontWeight: '600',
  textAlign: 'center',
},
proQuickButtonClearText: {
  fontSize: 11,
  color: '#FF5722',
  fontWeight: '600',
},

// Add these to your styles object
plantGuideButton: {
  backgroundColor: "#4CAF50",
  paddingVertical: 12,
  paddingHorizontal: 20,
  borderRadius: 25,
  marginBottom: 280,
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 5,
  alignSelf: 'center',
  marginTop: 10,
},
plantGuideButtonText: {
  color: "white",
  fontSize: 16,
  fontWeight: "bold",
},
plantGuideModalContainer: {
  flex: 1,
  justifyContent: "center",
  alignItems: "center",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
},
plantGuideModalContent: {
  backgroundColor: "white",
  borderRadius: 20,
  padding: 25,
  width: "90%",
  maxWidth: 400,
  maxHeight: "80%",
  shadowColor: "#000",
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.3,
  shadowRadius: 8,
  elevation: 8,
},
plantGuideHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 20,
  paddingBottom: 15,
  borderBottomWidth: 1,
  borderBottomColor: "#E0E0E0",
},
plantGuideTitle: {
  fontSize: 22,
  fontWeight: "700",
  color: "#2E7D32",
},
plantGuideCloseButton: {
  width: 32,
  height: 32,
  borderRadius: 16,
  backgroundColor: "#E8F5E9",
  alignItems: "center",
  justifyContent: "center",
},
plantGuideCloseText: {
  fontSize: 18,
  color: "#2E7D32",
  fontWeight: "bold",
},
plantGuideCard: {
  backgroundColor: "#F8F9FA",
  borderRadius: 15,
  padding: 20,
  alignItems: "center",
  marginBottom: 20,
  borderWidth: 1,
  borderColor: "#E0E0E0",
},
plantGuideEmoji: {
  fontSize: 48,
  marginBottom: 10,
},
plantGuideNumber: {
  fontSize: 14,
  color: "#666",
  marginBottom: 5,
  fontWeight: "500",
},
plantGuideName: {
  fontSize: 24,
  fontWeight: "bold",
  color: "#2E7D32",
  marginBottom: 10,
  textAlign: "center",
},
plantGuideDescription: {
  fontSize: 16,
  color: "#666",
  textAlign: "center",
  marginBottom: 15,
  lineHeight: 22,
},
wateringInfo: {
  backgroundColor: "#E3F2FD",
  padding: 15,
  borderRadius: 10,
  width: "100%",
  borderLeftWidth: 4,
  borderLeftColor: "#2196F3",
},
wateringLabel: {
  fontSize: 16,
  fontWeight: "bold",
  color: "#1976D2",
  marginBottom: 5,
},
wateringSchedule: {
  fontSize: 14,
  color: "#333",
  lineHeight: 20,
},
plantGuideNavigation: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 15,
  paddingHorizontal: 10,
},
navButton: {
  paddingVertical: 10,
  paddingHorizontal: 15,
  borderRadius: 8,
  backgroundColor: "#E8F5E9",
  borderWidth: 1,
  borderColor: "#4CAF50",
},
navButtonText: {
  color: "#2E7D32",
  fontSize: 14,
  fontWeight: "600",
},
disabledNavButton: {
  color: "#9E9E9E",
  opacity: 0.5,
},
pageIndicator: {
  fontSize: 16,
  fontWeight: "600",
  color: "#666",
},
plantGuideCloseMainButton: {
  backgroundColor: "#4CAF50",
  paddingVertical: 14,
  borderRadius: 12,
  alignItems: "center",
  width: "100%",
},
plantGuideCloseMainText: {
  color: "white",
  fontSize: 16,
  fontWeight: "bold",
},

plantsContainer: {
  width: '100%',
  flex: 1,
},

mainContent: {
  flex: 1,
  width: '100%',
},

// NEW NOTIFICATION STYLES
notificationSectionCard: {
  backgroundColor: "#FFF3E0",
  borderLeftWidth: 4,
  borderLeftColor: "#FF9800",
},

notificationHeader: {
  flexDirection: "row",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 1,
},

notificationTextContainer: {
  flex: 1,
  marginRight: 12,
},

notificationTitle: {
  fontSize: 16,
  fontWeight: "700",
  color: "#2E7D32",
  marginBottom: 4,
},

notificationDescription: {
  fontSize: 12,
  color: "#666",
  lineHeight: 16,
},

notificationHint: {
  fontSize: 12,
  color: "#FF9800",
  fontStyle: "italic",
  textAlign: "center",
  backgroundColor: "rgba(255, 152, 0, 0.1)",
  padding: 8,
  borderRadius: 6,
  marginBottom: 8,
},

testNotificationButton: {
  backgroundColor: "#2196F3",
  paddingVertical: 10,
  paddingHorizontal: 16,
  borderRadius: 8,
  alignItems: "center",
  marginTop: 8,
},

testNotificationText: {
  color: "white",
  fontSize: 14,
  fontWeight: "600",
},

notificationToggleButton: {
  backgroundColor: "#4CAF50",
  paddingVertical: 15,
  paddingHorizontal: 20,
  borderRadius: 15,
  marginVertical: 150,
  shadowColor: "#2E7D32",
  shadowOffset: { width: 0, height: 2 },
  shadowOpacity: 0.3,
  shadowRadius: 4,
  elevation: 5,
  alignSelf: 'center',
},

notificationToggleButtonText: {
  color: "white",
  fontSize: 16,
  fontWeight: "bold",
},
});