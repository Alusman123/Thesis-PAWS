// firebaseConfig.js - WITH IMPROVED DATA RESTORATION SYSTEM
import { ref, set, get, remove, update } from 'firebase/database';
import { initializeApp } from 'firebase/app';
import { initializeAuth, getReactNativePersistence, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import { getDatabase } from 'firebase/database';
import AsyncStorage from '@react-native-async-storage/async-storage';

const firebaseConfig = {
  apiKey: "AIzaSyCKeuiqCzGr3vuhQ_bNHoKBfvHeFuuoxVQ",
  authDomain: "aws-data-dd636.firebaseapp.com",
  databaseURL: "https://aws-data-dd636-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "aws-data-dd636",
  storageBucket: "aws-data-dd636.firebasestorage.app",
  messagingSenderId: "194988042185",
  appId: "1:194988042185:web:402062196cb19043c96a18",
  measurementId: "G-NWEX79R0XR"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

let auth;
try {
  auth = initializeAuth(app, {
    persistence: getReactNativePersistence(AsyncStorage)
  });
} catch (error) {
  if (error.code === 'auth/already-initialized') {
    const { getAuth } = require('firebase/auth');
    auth = getAuth(app);
  } else {
    throw error;
  }
}

export { auth };
export const db = getDatabase(app);
export default app;

// Helper function to get user-friendly error messages
const getFirebaseAuthErrorMessage = (error) => {
  switch (error.code) {
    case 'auth/invalid-email':
      return 'Invalid email address format.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/user-not-found':
      return 'No account found with this email. Please register first.';
    case 'auth/wrong-password':
      return 'Invalid OTP. Please try again.';
    case 'auth/email-already-in-use':
      return 'An account with this email already exists.';
    case 'auth/weak-password':
      return 'Password is too weak.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please try again later.';
    case 'auth/invalid-credential':
      return 'Invalid OTP. Please request a new OTP.';
    case 'auth/user-token-expired':
      return 'Session expired. Please login again.';
    default:
      return error.message || 'An unexpected error occurred.';
  }
};

// OTP Storage
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Resend.com Email Service
const sendOTPEmail = async (email, otp, purpose = 'login') => {
  try {
    const RESEND_API_KEY = 're_9pViz2zs_KMAL15eP61XnJanpKGWbpNCV';
    const fromEmail = 'PAWS <noreply@myplantapp.site>';
    
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RESEND_API_KEY}`
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [email],
        subject: `Your PAWS Verification Code - ${purpose === 'register' ? 'Account Registration' : 'Login'}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #2E7D32; text-align: center;">🌱 PAWS Plant System</h2>
            <div style="background: #f8f9fa; padding: 20px; border-radius: 10px; text-align: center; margin: 20px 0;">
              <h3 style="color: #2E7D32; margin: 0 0 15px 0;">Your Verification Code</h3>
              <div style="background: white; padding: 15px; margin: 15px 0; border-radius: 8px; border: 2px dashed #4CAF50;">
                <h1 style="margin: 0; color: #2E7D32; letter-spacing: 8px; font-size: 32px; font-family: monospace;">${otp}</h1>
              </div>
              <p style="color: #666; margin: 10px 0;">
                Use this code to <strong>${purpose === 'register' ? 'create your account' : 'login to your account'}</strong>
              </p>
              <p style="color: #FF9800; font-size: 12px; margin: 10px 0 0 0;">
                ⚠️ This code expires in 10 minutes
              </p>
            </div>
            <p style="color: #999; font-size: 12px; text-align: center;">
              If you didn't request this code, please ignore this email.
            </p>
          </div>
        `
      })
    });

    const data = await response.json();

    if (response.ok) {
      console.log('✅ OTP email sent successfully to:', email);
      return { success: true };
    } else {
      console.log('❌ Email service failed, using fallback. Error:', data);
      return { success: true, demoOTP: otp };
    }
  } catch (error) {
    console.log('❌ Network error, using fallback OTP display. Error:', error);
    return { success: true, demoOTP: otp };
  }
};

// ==================== IMPROVED DATA RESTORATION FUNCTIONS ====================

// Get user's plants data
const getUserPlants = async (userId) => {
  try {
    const plantsRef = ref(db, `Users/${userId}/plants`);
    const snapshot = await get(plantsRef);
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.log('⚠️ Error getting user plants:', error.message);
    return null;
  }
};

// Get user's devices data
const getUserDevices = async (userId) => {
  try {
    const devicesRef = ref(db, `Users/${userId}/devices`);
    const snapshot = await get(devicesRef);
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.log('⚠️ Error getting user devices:', error.message);
    return null;
  }
};

// Get user's schedules data
const getUserSchedules = async (userId) => {
  try {
    const schedulesRef = ref(db, `Schedules/${userId}`);
    const snapshot = await get(schedulesRef);
    return snapshot.exists() ? snapshot.val() : null;
  } catch (error) {
    console.log('⚠️ Error getting user schedules:', error.message);
    return null;
  }
};

// Store email mapping with proper structure
const storeEmailMapping = async (user) => {
  try {
    if (!user || !user.email) {
      console.log('❌ No user or email found for mapping');
      return false;
    }
    
    console.log('📝 Storing email mapping for:', user.email);
    
    // Get user data before deletion
    const plants = await getUserPlants(user.uid);
    const devices = await getUserDevices(user.uid);
    const schedules = await getUserSchedules(user.uid);
    
    // Store mapping using email as key (encoded to handle special characters)
    const emailKey = user.email.replace(/[.#$[\]]/g, '_');
    const emailMappingRef = ref(db, `EmailToUIDMapping/${emailKey}`);
    
    await set(emailMappingRef, {
      email: user.email,
      originalUid: user.uid,
      deletedAt: Date.now(),
      plants: plants || {},
      devices: devices || {},
      schedules: schedules || {},
      deviceCount: devices ? Object.keys(devices).length : 0,
      plantCount: plants ? Object.keys(plants).length : 0
    });
    
    console.log('✅ Email mapping stored successfully');
    console.log('📊 Devices saved:', devices ? Object.keys(devices).length : 0);
    console.log('📊 Plants saved:', plants ? Object.keys(plants).length : 0);
    
    return true;
  } catch (error) {
    console.log('⚠️ Could not store email mapping:', error.message);
    return false;
  }
};

// Find previous user data by email (improved)
const findPreviousUserData = async (email) => {
  try {
    console.log('🔍 Looking for previous data for email:', email);
    
    const emailKey = email.replace(/[.#$[\]]/g, '_');
    const emailMapRef = ref(db, `EmailToUIDMapping/${emailKey}`);
    const snapshot = await get(emailMapRef);
    
    if (snapshot.exists()) {
      const mapping = snapshot.val();
      console.log('✅ Found previous account data for:', email);
      
      const hasPlants = mapping.plants && Object.keys(mapping.plants).length > 0;
      const hasDevices = mapping.devices && Object.keys(mapping.devices).length > 0;
      const hasSchedules = mapping.schedules && Object.keys(mapping.schedules).length > 0;
      
      console.log('📊 Data found:', {
        plants: mapping.plantCount || 0,
        devices: mapping.deviceCount || 0,
        schedules: hasSchedules
      });
      
      return { 
        data: mapping,
        hasPlants: hasPlants,
        hasDevices: hasDevices,
        hasSchedules: hasSchedules
      };
    }
    
    console.log('❌ No previous data found for:', email);
    return null;
  } catch (error) {
    console.log('⚠️ Error finding previous data:', error.message);
    return null;
  }
};

// Improved data restoration
const restoreUserData = async (newUserId, previousData) => {
  try {
    console.log('🔄 Restoring data to new UID:', newUserId);
    
    let restoredCount = 0;
    const updates = {};
    
    // Restore devices (most important)
    if (previousData.hasDevices && previousData.data.devices) {
      updates[`Users/${newUserId}/devices`] = previousData.data.devices;
      restoredCount++;
      console.log('✅ Restoring devices:', Object.keys(previousData.data.devices).length);
    }
    
    // Restore plants
    if (previousData.hasPlants && previousData.data.plants) {
      updates[`Users/${newUserId}/plants`] = previousData.data.plants;
      restoredCount++;
      console.log('✅ Restoring plants:', Object.keys(previousData.data.plants).length);
    }
    
    // Restore schedules
    if (previousData.hasSchedules && previousData.data.schedules) {
      updates[`Schedules/${newUserId}`] = previousData.data.schedules;
      restoredCount++;
      console.log('✅ Restoring schedules');
    }
    
    // Store user info
    updates[`Users/${newUserId}/userInfo`] = {
      email: previousData.data.email,
      accountRestored: true,
      restorationTime: Date.now(),
      restoredItems: restoredCount,
      previousUid: previousData.data.originalUid
    };
    
    // Execute all updates
    if (Object.keys(updates).length > 0) {
      await update(ref(db), updates);
      console.log('🎉 Data restoration completed. Items restored:', restoredCount);
      return restoredCount;
    } else {
      console.log('ℹ️ No data to restore');
      return 0;
    }
    
  } catch (error) {
    console.log('⚠️ Error restoring data:', error.message);
    return 0;
  }
};

// ==================== ACCOUNT DELETION WITH IMPROVED DATA RESTORATION ====================

export const deleteUserAccount = async () => {
  try {
    const user = auth.currentUser;
    
    if (!user) {
      return { success: false, error: 'No user logged in. Please login again.' };
    }
    
    console.log('🗑️ Starting account deletion for:', user.email);
    
    // STEP 1: Store mapping for data restoration FIRST
    console.log('💾 Backing up user data...');
    const mappingStored = await storeEmailMapping(user);
    
    if (!mappingStored) {
      console.log('⚠️ Failed to backup data, but continuing with deletion');
    }
    
    // STEP 2: Delete user data from Firebase
    try {
      const userDataRef = ref(db, `Users/${user.uid}`);
      await remove(userDataRef);
      console.log('✅ User data deleted from database');
    } catch (dbError) {
      console.log('⚠️ Error deleting database data:', dbError.message);
      // Continue with auth deletion
    }
    
    // STEP 3: Delete auth account
    try {
      await user.delete();
      console.log('✅ Auth account deleted successfully');
      
      return { 
        success: true, 
        message: mappingStored ? 
          'Account deleted successfully. Your devices and data will be restored if you register again with the same email.' :
          'Account deleted. Some data may not be recoverable.'
      };
    } catch (authError) {
      if (authError.code === 'auth/requires-recent-login') {
        console.log('🔄 Account deletion requires recent login');
        await signOut(auth);
        return { 
          success: false, 
          error: 'For security reasons, please login again to delete your account. Your data has been saved for restoration.' 
        };
      }
      throw authError;
    }
    
  } catch (error) {
    console.error('💥 Error in deleteUserAccount:', error);
    
    try {
      await signOut(auth);
    } catch (signOutError) {
      console.error('Error signing out:', signOutError);
    }
    
    return { 
      success: false, 
      error: getFirebaseAuthErrorMessage(error)
    };
  }
};

// ==================== OTP FUNCTIONS WITH IMPROVED DATA RESTORATION ====================

export const sendOTP = async (email, purpose = 'login') => {
  try {
    const otp = generateOTP();
    const otpExpiry = Date.now() + 10 * 60 * 1000;

    await AsyncStorage.setItem('otpData', JSON.stringify({
      email: email,
      otp: otp,
      purpose: purpose,
      expiresAt: otpExpiry,
    }));

    console.log('📧 Attempting to send OTP email...');
    
    const emailResult = await sendOTPEmail(email, otp, purpose);
    
    if (emailResult.demoOTP) {
      console.log('📱 Using fallback - OTP will be shown in app:', otp);
    } else {
      console.log('✅ OTP sent to email successfully');
    }
    
    return {
      success: true,
      demoOTP: emailResult.demoOTP || null
    };

  } catch (error) {
    console.error('Error sending OTP:', error);
    return {
      success: false,
      error: 'Failed to send OTP. Please try again.'
    };
  }
};

export const verifyOTP = async (email, enteredOTP, purpose = 'login') => {
  try {
    console.log('🔍 Starting OTP verification for:', email, 'Purpose:', purpose);
    
    const otpData = await AsyncStorage.getItem('otpData');
    
    if (!otpData) {
      return { success: false, error: 'No OTP found. Please request a new OTP.' };
    }

    const { email: storedEmail, otp: storedOTP, expiresAt } = JSON.parse(otpData);
    
    if (storedEmail !== email || storedOTP !== enteredOTP) {
      return { success: false, error: 'Invalid OTP.' };
    }

    if (Date.now() > expiresAt) {
      await AsyncStorage.removeItem('otpData');
      return { success: false, error: 'OTP has expired. Please request a new one.' };
    }

    await AsyncStorage.removeItem('otpData');

    const password = enteredOTP + '_paws_temp';

    if (purpose === 'register') {
      // Check for previous data BEFORE creating account
      const previousData = await findPreviousUserData(email);
      
      console.log('🚀 Creating new account for:', email);
      const userCredential = await createUserWithEmailAndPassword(auth, email, password);
      const newUserId = userCredential.user.uid;
      
      console.log('✅ New account created with UID:', newUserId);
      
      // Restore data if found
      let restoredItems = 0;
      if (previousData) {
        restoredItems = await restoreUserData(newUserId, previousData);
        console.log('📦 Data restoration completed. Items restored:', restoredItems);
      }
      
      let message = 'Account created successfully! Welcome to PAWS!';
      if (restoredItems > 0) {
        message = `Welcome back! Your previous ${restoredItems} device(s) and data have been automatically restored.`;
      }
      
      return { 
        success: true, 
        message: message,
        user: userCredential.user,
        dataRestored: restoredItems > 0,
        restoredItems: restoredItems
      };
    } else {
      // Login flow
      try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        return { 
          success: true, 
          message: 'Welcome back to PAWS!',
          user: userCredential.user
        };
      } catch (error) {
        if (error.code === 'auth/user-not-found') {
          return { 
            success: false, 
            error: 'No account found with this email. Please register first.'
          };
        }
        throw error;
      }
    }
    
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return { 
      success: false, 
      error: getFirebaseAuthErrorMessage(error)
    };
  }
};

export const resetUserPassword = async (email, newOTP) => {
  try {
    await signOut(auth);
    const password = newOTP + '_paws_temp';
    
    try {
      await signInWithEmailAndPassword(auth, email, password);
      return { success: true, message: 'Please use this OTP for future logins: ' + newOTP };
    } catch (error) {
      return { success: false, error: 'Could not reset password. Please contact support.' };
    }
    
  } catch (error) {
    console.error('Error resetting password:', error);
    return { success: false, error: 'Password reset failed.' };
  }
};