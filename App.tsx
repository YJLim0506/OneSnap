import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Image,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Vibration,
  Modal,
  Platform,
  PermissionsAndroid,
  ScrollView,
} from 'react-native';
import { launchCamera, launchImageLibrary, ImagePickerResponse } from 'react-native-image-picker';
import Geolocation from '@react-native-community/geolocation';
import MapView, { Marker, Region } from 'react-native-maps';
import { ROBOFLOW_API_KEY } from './config.secret';
import { db, storage } from './firebaseConfig';
import { collection, addDoc, getDocs, query, orderBy, doc, getDoc, setDoc } from 'firebase/firestore';
import { ref, uploadString, getDownloadURL } from 'firebase/storage';

// ================== Domain Models ==================

type ReportType = 'POTHOLE' | 'TRASH' | 'VANDALISM';

type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH';

type ReportStatus = 'PENDING' | 'IN_PROGRESS' | 'RESOLVED';

interface User {
  id: string;
  name: string;
  icNumber: string;
  isVerified: boolean;
}

interface Location {
  latitude: number;
  longitude: number;
  address?: string;
}

// Workflow "detect-count-and-visualize" response shape (matches Roboflow workflow output)
interface WorkflowPrediction {
  confidence: number;
  class?: string;
  class_id?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

interface WorkflowOutputItem {
  count_objects?: number;
  output_image?: { type: string; value: string; [key: string]: unknown };
  predictions?: {
    image?: { width: number; height: number };
    predictions?: WorkflowPrediction[];
  };
  [key: string]: unknown;
}

interface RoboflowWorkflowResponse {
  outputs?: WorkflowOutputItem[];
  profiler_trace?: unknown[];
}

// Standard Roboflow model response (e.g. garbage-detection-aylah/9)
interface RoboflowModelPrediction {
  class: string;
  confidence: number;
  [key: string]: unknown;
}

interface RoboflowModelResponse {
  predictions?: RoboflowModelPrediction[];
  [key: string]: unknown;
}

interface ReportPayload {
  reporter: User;
  type: ReportType;
  photoUri: string;
  photoBase64?: string;
  location: Location;
  description: string;
  severity: SeverityLevel;
  createdAt: string;
}

interface SubmittedReport extends ReportPayload {
  id: string;
  status: ReportStatus;
}

// ================== Service Interfaces ==================
// (Dependency Inversion: UI depends on these abstractions, not concrete APIs)

interface AuthService {
  /** Login by name + IC. Sign up can pass IC photos (base64) to store. */
  login(payload: {
    name: string;
    icNumber: string;
    icFrontBase64?: string;
    icBackBase64?: string;
  }): Promise<User>;
}

interface LocationService {
  getCurrentLocation(): Promise<Location>;
}

interface AiModelService {
  inferSeverity(imageData: string, type: ReportType): Promise<{
    severity: SeverityLevel;
    confidence: number; // e.g. 0–1
  }>;
}

interface ReportService {
  submitReport(report: ReportPayload): Promise<void>;
}

// ================== Mock Implementations ==================
// Replace these with real Firebase / Roboflow / GPS logic later.

const USERS_COLLECTION = 'users';

/** Normalize IC to digits only for use as doc id. */
function icToUserId(icNumber: string): string {
  return icNumber.replace(/\D/g, '');
}

function stripBase64Prefix(data: string): string {
  const match = data.match(/^data:image\/\w+;base64,(.+)$/);
  return match ? match[1] : data;
}

class FirebaseAuthService implements AuthService {
  async login(payload: {
    name: string;
    icNumber: string;
    icFrontBase64?: string;
    icBackBase64?: string;
  }): Promise<User> {
    const name = payload.name.trim();
    const icNumber = payload.icNumber.trim();
    const id = icToUserId(icNumber);
    if (!id) throw new Error('Invalid IC number');

    const usersRef = collection(db, USERS_COLLECTION);
    const userRef = doc(usersRef, id);
    const snapshot = await getDoc(userRef);

    if (snapshot.exists()) {
      const d = snapshot.data();
      const storedName = (d.name as string) || name;
      const storedIc = (d.icNumber as string) || icNumber;
      if (storedName !== name) {
        await setDoc(userRef, { name, updatedAt: new Date().toISOString() }, { merge: true });
      }
      return {
        id: snapshot.id,
        name,
        icNumber: storedIc,
        isVerified: true,
      };
    }

    const newUser: User = {
      id,
      name,
      icNumber,
      isVerified: true,
    };

    const userData: Record<string, unknown> = {
      name: newUser.name,
      icNumber: newUser.icNumber,
      createdAt: new Date().toISOString(),
    };

    if (payload.icFrontBase64 && payload.icBackBase64) {
      try {
        const frontRef = ref(storage, `users/${id}/ic_front.jpg`);
        const backRef = ref(storage, `users/${id}/ic_back.jpg`);
        await uploadString(frontRef, stripBase64Prefix(payload.icFrontBase64), 'base64');
        await uploadString(backRef, stripBase64Prefix(payload.icBackBase64), 'base64');
        userData.icFrontUrl = await getDownloadURL(frontRef);
        userData.icBackUrl = await getDownloadURL(backRef);
      } catch (e) {
        console.warn('IC photo upload failed, saving user without photos', e);
      }
    }

    await setDoc(userRef, userData);
    return newUser;
  }
}

/** Reverse geocode lat/lng to address (OpenStreetMap Nominatim, no key required) */
async function reverseGeocode(latitude: number, longitude: number): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${latitude}&lon=${longitude}&format=json`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': 'OneSnap/1.0' } }
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name;
  } catch {
    return undefined;
  }
}

class RealLocationService implements LocationService {
  async getCurrentLocation(): Promise<Location> {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'Location for report',
          message: 'OneSnap needs your location to attach to the report.',
          buttonNeutral: 'Ask Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'OK',
        }
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {
        throw new Error('Location permission denied');
      }
    }

    return new Promise((resolve, reject) => {
      // Use cached location if recent (faster). On Android, enableHighAccuracy can cause slow/timeout indoors.
      const opts = {
        enableHighAccuracy: Platform.OS === 'ios',
        timeout: 25000,
        maximumAge: 60000,
      };
      Geolocation.getCurrentPosition(
        async (position: { coords: { latitude: number; longitude: number } }) => {
          const latitude = position.coords.latitude;
          const longitude = position.coords.longitude;
          const address = await reverseGeocode(latitude, longitude);
          resolve({ latitude, longitude, address });
        },
        (err: { message?: string }) => reject(new Error(err.message || 'Location timed out or unavailable')),
        opts
      );
    });
  }
}

class RoboflowAiModelService implements AiModelService {
  async inferSeverity(
    imageData: string,
    type: ReportType
  ): Promise<{ severity: SeverityLevel; confidence: number }> {
    if (!imageData || !imageData.trim()) {
      return { severity: 'LOW', confidence: 0 };
    }

    const apiKey = ROBOFLOW_API_KEY || '';

    if (type === 'TRASH') {
      return this.inferTrash(imageData, apiKey);
    }
    if (type === 'VANDALISM') {
      return this.inferVandalism(imageData, apiKey);
    }

    return this.inferWorkflow(imageData, apiKey);
  }

  /** Vandalism: vandalism-zfcdk model — raw base64 body, api_key in query (same as axios example). */
  private async inferVandalism(
    imageData: string,
    apiKey: string
  ): Promise<{ severity: SeverityLevel; confidence: number }> {
    try {
      const rawBase64 = imageData.startsWith('data:')
        ? imageData.replace(/^data:image\/\w+;base64,/, '')
        : imageData;

      const url = `https://serverless.roboflow.com/vandalism-zfcdk/1?api_key=${encodeURIComponent(apiKey)}`;
      console.log('[Vandalism API] Sending image to Roboflow vandalism-zfcdk/1, payload size (base64 chars):', rawBase64.length);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rawBase64,
      });

      console.log('[Vandalism API] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Roboflow error: ${response.status} ${errText}`);
      }

      const result: RoboflowModelResponse = await response.json();
      const predictions = result.predictions ?? [];
      const topConf = predictions.length > 0 ? Math.round(Math.max(...predictions.map((p) => p.confidence)) * 100) : 0;
      console.log('[Vandalism API] Success. Predictions count:', predictions.length, predictions.length > 0 ? '| top confidence: ' + topConf + '%' : '');

      let confidence = 0;
      if (predictions.length > 0) {
        const top = predictions.reduce(
          (max, p) => (p.confidence > max.confidence ? p : max),
          predictions[0]
        );
        confidence = top.confidence;
      }

      const severity: SeverityLevel =
        confidence > 0.85 ? 'HIGH' : confidence > 0.5 ? 'MEDIUM' : 'LOW';
      return { severity, confidence };
    } catch (error) {
      console.warn('[Vandalism API] Error', error);
      return { severity: 'LOW', confidence: 0 };
    }
  }

  /** Trash (lapsap): garbage-detection model — raw base64 body, api_key in query. */
  private async inferTrash(
    imageData: string,
    apiKey: string
  ): Promise<{ severity: SeverityLevel; confidence: number }> {
    try {
      const rawBase64 = imageData.startsWith('data:')
        ? imageData.replace(/^data:image\/\w+;base64,/, '')
        : imageData;

      const url = `https://serverless.roboflow.com/garbage-detection-aylah/9?api_key=${encodeURIComponent(apiKey)}`;
      console.log('[Lapsap/Trash API] Sending image from phone to Roboflow garbage-detection-aylah/9, payload size (base64 chars):', rawBase64.length);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rawBase64,
      });

      console.log('[Lapsap/Trash API] Response status:', response.status, response.statusText);

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Roboflow error: ${response.status} ${errText}`);
      }

      const result: RoboflowModelResponse = await response.json();
      const predictions = result.predictions ?? [];
      const topConf = predictions.length > 0 ? Math.round(Math.max(...predictions.map((p) => p.confidence)) * 100) : 0;
      console.log('[Lapsap/Trash API] Success. Predictions count:', predictions.length, predictions.length > 0 ? '| top confidence: ' + topConf + '%' : '');

      let confidence = 0;
      if (predictions.length > 0) {
        const top = predictions.reduce(
          (max, p) => (p.confidence > max.confidence ? p : max),
          predictions[0]
        );
        confidence = top.confidence;
      }

      const severity: SeverityLevel =
        confidence > 0.85 ? 'HIGH' : confidence > 0.5 ? 'MEDIUM' : 'LOW';
      return { severity, confidence };
    } catch (error) {
      console.warn('[Lapsap/Trash API] Error', error);
      return { severity: 'LOW', confidence: 0 };
    }
  }

  /** Pothole: workflow API — JSON body with data URL image. */
  private async inferWorkflow(
    imageData: string,
    apiKey: string
  ): Promise<{ severity: SeverityLevel; confidence: number }> {
    try {
      const base64String = imageData.startsWith('data:')
        ? imageData
        : `data:image/jpeg;base64,${imageData}`;

      const response = await fetch(
        'https://serverless.roboflow.com/haos-workspace-pm46v/workflows/detect-count-and-visualize',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            api_key: apiKey,
            inputs: { image: base64String },
          }),
        }
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Roboflow error: ${response.status} ${errText}`);
      }

      const result: RoboflowWorkflowResponse = await response.json();
      const firstOutput = result.outputs?.[0];
      const count =
        typeof firstOutput?.count_objects === 'number'
          ? firstOutput.count_objects
          : 0;
      const predictionList =
        firstOutput?.predictions?.predictions ?? ([] as WorkflowPrediction[]);

      let confidence = 0;
      if (predictionList.length > 0) {
        const top = predictionList.reduce(
          (max, p) => (p.confidence > max.confidence ? p : max),
          predictionList[0]
        );
        confidence = top.confidence;
      }
      if (confidence === 0 && count > 0) {
        confidence = Math.min(0.5 + count * 0.15, 1);
      }

      const severity: SeverityLevel =
        confidence > 0.85 ? 'HIGH' : confidence > 0.5 ? 'MEDIUM' : 'LOW';
      return { severity, confidence };
    } catch (error) {
      console.warn('Roboflow workflow error', error);
      return { severity: 'LOW', confidence: 0 };
    }
  }
}

class FirebaseReportService implements ReportService {
  async submitReport(report: ReportPayload): Promise<void> {
    let photoUrl = report.photoUri;

    // Upload image to Firebase Storage if base64 data is available
    if (report.photoBase64) {
      try {
        const imageRef = ref(storage, `reports/${Date.now()}.jpg`);
        await uploadString(imageRef, report.photoBase64, 'base64');
        photoUrl = await getDownloadURL(imageRef);
      } catch (error) {
        console.warn('Image upload failed, using local URI', error);
      }
    }

    // Write report document to Firestore
    await addDoc(collection(db, 'reports'), {
      reporterName: report.reporter.name,
      reporterIc: report.reporter.icNumber,
      reporterId: report.reporter.id,
      type: report.type,
      photoUrl,
      latitude: report.location.latitude,
      longitude: report.location.longitude,
      address: report.location.address || '',
      description: report.description,
      severity: report.severity,
      status: 'PENDING',
      createdAt: report.createdAt,
    });
  }
}

// ================== Service Context (DI Container) ==================

interface ServiceContainer {
  authService: AuthService;
  locationService: LocationService;
  aiModelService: AiModelService;
  reportService: ReportService;
}

const ServiceContext = createContext<ServiceContainer | null>(null);

const useServices = (): ServiceContainer => {
  const ctx = useContext(ServiceContext);
  if (!ctx) {
    throw new Error('ServiceContext not provided');
  }
  return ctx;
};

// ================== Navigation State ==================

type Screen =
  | { name: 'LOGIN' }
  | { name: 'HOME' }
  | { name: 'REPORT_TYPE' }
  | { name: 'REPORT_CAPTURE'; type: ReportType }
  | { name: 'MY_REPORTS' };

const App: React.FC = () => {
  const [user, setUser] = useState<User | null>(null);
  const [screen, setScreen] = useState<Screen>({ name: 'LOGIN' });
  const [reports, setReports] = useState<SubmittedReport[]>([]);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [authScreen, setAuthScreen] = useState<'LOGIN' | 'SIGN_UP'>('LOGIN');

  const services: ServiceContainer = {
    authService: new FirebaseAuthService(),
    locationService: new RealLocationService(),
    aiModelService: new RoboflowAiModelService(),
    reportService: new FirebaseReportService(),
  };

  // Fetch existing reports from Firestore on mount
  const fetchReports = async () => {
    try {
      const q = query(collection(db, 'reports'), orderBy('createdAt', 'desc'));
      const snapshot = await getDocs(q);
      const fetched: SubmittedReport[] = snapshot.docs.map((doc) => {
        const d = doc.data();
        return {
          id: doc.id,
          reporter: {
            id: d.reporterId || '',
            name: d.reporterName || '',
            icNumber: d.reporterIc || '',
            isVerified: true,
          },
          type: d.type as ReportType,
          photoUri: d.photoUrl || '',
          location: {
            latitude: d.latitude || 0,
            longitude: d.longitude || 0,
            address: d.address || '',
          },
          description: d.description || '',
          severity: d.severity as SeverityLevel,
          createdAt: d.createdAt || '',
          status: (d.status || 'PENDING') as ReportStatus,
        };
      });
      setReports(fetched);
    } catch (error) {
      console.warn('Failed to fetch reports from Firestore', error);
    }
  };

  useEffect(() => {
    fetchReports();
  }, []);

  const handleSignedIn = (signedInUser: User) => {
    setUser(signedInUser);
    setScreen({ name: 'HOME' });
  };

  const handleReportSubmitted = (report: SubmittedReport) => {
    setReports((prev) => [report, ...prev]);
    setScreen({ name: 'MY_REPORTS' });
  };

  const currentTab: 'HOME' | 'REPORT' | 'MY_REPORTS' =
    screen.name === 'REPORT_TYPE' || screen.name === 'REPORT_CAPTURE'
      ? 'REPORT'
      : screen.name === 'MY_REPORTS'
        ? 'MY_REPORTS'
        : 'HOME';

  const renderScreen = () => {
    if (!user) {
      if (authScreen === 'SIGN_UP') {
        return (
          <SignUpScreen
            onSignedUp={handleSignedIn}
            onGoToLogIn={() => setAuthScreen('LOGIN')}
          />
        );
      }
      return (
        <LoginScreen
          onLoggedIn={handleSignedIn}
          onGoToSignUp={() => setAuthScreen('SIGN_UP')}
        />
      );
    }

    switch (screen.name) {
      case 'HOME':
        return <HomeScreen onStartReport={() => setScreen({ name: 'REPORT_TYPE' })} user={user} />;
      case 'REPORT_TYPE':
        return (
          <ReportTypeScreen
            onSelectType={(type) => setScreen({ name: 'REPORT_CAPTURE', type })}
            onBack={() => setScreen({ name: 'HOME' })}
          />
        );
      case 'REPORT_CAPTURE':
        return (
          <ReportCaptureScreen
            user={user}
            reportType={screen.type}
            onBack={() => setScreen({ name: 'REPORT_TYPE' })}
            onSubmitted={handleReportSubmitted}
          />
        );
      case 'MY_REPORTS':
        return <MyReportsScreen reports={reports} onBack={() => setScreen({ name: 'HOME' })} />;
      default:
        return null;
    }
  };

  // History is kept in memory only for this hackathon build.

  const openSettings = () => setShowSettingsModal(true);
  const closeSettings = () => setShowSettingsModal(false);
  const handleViewPreviousReport = () => {
    closeSettings();
    setScreen({ name: 'MY_REPORTS' });
  };
  const handleLogout = () => {
    closeSettings();
    setUser(null);
    setScreen({ name: 'LOGIN' });
  };

  return (
    <ServiceContext.Provider value={services}>
      <SafeAreaView style={styles.container}>
        {user ? (
          <>
            <View style={styles.appShell}>
              <View style={styles.topBar}>
                <View style={styles.topBarSpacer} />
                <TouchableOpacity
                  onPress={openSettings}
                  style={styles.settingsIconButton}
                  accessibilityLabel="Settings"
                >
                  <Text style={styles.settingsIcon}>⚙</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.screenContent}>{renderScreen()}</View>
            </View>
            <Modal
              visible={showSettingsModal}
              transparent
              animationType="fade"
              onRequestClose={closeSettings}
            >
              <TouchableOpacity
                style={styles.settingsModalOverlay}
                activeOpacity={1}
                onPress={closeSettings}
              >
                <View style={styles.settingsModalCard} onStartShouldSetResponder={() => true}>
                  <Text style={styles.settingsModalTitle}>Settings</Text>
                  <TouchableOpacity
                    style={styles.settingsModalOption}
                    onPress={handleViewPreviousReport}
                  >
                    <Text style={styles.settingsModalOptionText}>View previous report</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.settingsModalOption} onPress={handleLogout}>
                    <Text style={[styles.settingsModalOptionText, styles.settingsModalOptionDanger]}>
                      Log out
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryButton} onPress={closeSettings}>
                    <Text style={styles.secondaryButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </TouchableOpacity>
            </Modal>
          </>
        ) : (
          <View style={styles.appShell}>{renderScreen()}</View>
        )}
        {user && (
          <BottomNav
            activeTab={currentTab}
            onPressHome={() => setScreen({ name: 'HOME' })}
            onPressReport={() => setScreen({ name: 'REPORT_TYPE' })}
            onPressMyReports={() => setScreen({ name: 'MY_REPORTS' })}
          />
        )}
      </SafeAreaView>
    </ServiceContext.Provider>
  );
};

// ================== Sign-up & Identity Verification ==================

const normalizeIcDigits = (value: string) => value.replace(/\D/g, '').slice(0, 12);

const formatIcNumber = (digits: string) => {
  if (digits.length <= 6) return digits;
  if (digits.length <= 8) {
    return `${digits.slice(0, 6)}-${digits.slice(6)}`;
  }
  return `${digits.slice(0, 6)}-${digits.slice(6, 8)}-${digits.slice(8, 12)}`;
};

const isValidIcFormat = (formatted: string) => /^\d{6}-\d{2}-\d{4}$/.test(formatted);

interface LoginScreenProps {
  onLoggedIn(user: User): void;
  onGoToSignUp(): void;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onLoggedIn, onGoToSignUp }) => {
  const { authService } = useServices();

  const [name, setName] = useState('');
  const [icNumber, setIcNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const icIsValid = isValidIcFormat(icNumber);
  const canSubmit = name.trim().length > 0 && icIsValid && !isLoading;

  const handleIcChange = (value: string) => {
    const digits = normalizeIcDigits(value);
    const formatted = formatIcNumber(digits);
    setIcNumber(formatted);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    try {
      setIsLoading(true);
      const user = await authService.login({
        name: name.trim(),
        icNumber: icNumber.trim(),
      });
      onLoggedIn(user);
    } catch (e) {
      Alert.alert('Login failed', 'Please check your name and IC number and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.appTitle}>OneSnap</Text>
      <Text style={styles.subtitle}>Smart City Issue Reporting</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Login</Text>

        <Text style={styles.label}>Full Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="Enter your name"
          style={styles.input}
          placeholderTextColor="#FFFFFF88"
        />

        <Text style={styles.label}>IC Number</Text>
        <TextInput
          value={icNumber}
          onChangeText={handleIcChange}
          placeholder="e.g. 990101-14-5678"
          style={styles.input}
          keyboardType="numeric"
          placeholderTextColor="#FFFFFF88"
        />
        {icNumber.length > 0 && !icIsValid && (
          <Text style={styles.errorText}>Invalid IC format. Example: 990101-01-1234</Text>
        )}

        <TouchableOpacity
          style={[styles.primaryButton, !canSubmit && styles.buttonDisabled]}
          disabled={!canSubmit}
          onPress={handleSubmit}
        >
          {isLoading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>Log in</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.textLinkButton} onPress={onGoToSignUp}>
          <Text style={styles.textLinkButtonText}>Sign up</Text>
        </TouchableOpacity>

        <Text style={styles.helperText}>
          Your name and IC are recorded for accountable reporting.
        </Text>
      </View>
    </View>
  );
};

interface SignUpScreenProps {
  onSignedUp(user: User): void;
  onGoToLogIn(): void;
}

const SignUpScreen: React.FC<SignUpScreenProps> = ({ onSignedUp, onGoToLogIn }) => {
  const { authService } = useServices();

  const [name, setName] = useState('');
  const [icNumber, setIcNumber] = useState('');
  const [icFrontUri, setIcFrontUri] = useState<string | null>(null);
  const [icBackUri, setIcBackUri] = useState<string | null>(null);
  const [icFrontBase64, setIcFrontBase64] = useState<string | null>(null);
  const [icBackBase64, setIcBackBase64] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const icIsValid = isValidIcFormat(icNumber);
  const canSubmit =
    name.trim().length > 0 &&
    icIsValid &&
    !!icFrontUri &&
    !!icBackUri &&
    !!icFrontBase64 &&
    !!icBackBase64 &&
    !isLoading;

  const handleIcChange = (value: string) => {
    const digits = normalizeIcDigits(value);
    const formatted = formatIcNumber(digits);
    setIcNumber(formatted);
  };

  const captureIcImage = async (side: 'front' | 'back') => {
    try {
      const response: ImagePickerResponse = await launchCamera({
        mediaType: 'photo',
        cameraType: 'back',
        quality: 0.8,
        includeBase64: true,
      });

      if (response.didCancel || !response.assets || !response.assets[0]?.uri) {
        return;
      }

      const asset = response.assets[0];
      const uri = asset.uri!;
      const base64 = asset.base64 ?? null;

      if (side === 'front') {
        setIcFrontUri(uri);
        setIcFrontBase64(base64);
      } else {
        setIcBackUri(uri);
        setIcBackBase64(base64);
      }
    } catch (e) {
      Alert.alert('Camera error', 'Unable to open camera. Please try again.');
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit || !icFrontBase64 || !icBackBase64) return;
    try {
      setIsLoading(true);
      const user = await authService.login({
        name: name.trim(),
        icNumber: icNumber.trim(),
        icFrontBase64,
        icBackBase64,
      });
      onSignedUp(user);
    } catch (e) {
      Alert.alert('Sign up failed', 'Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.appTitle}>OneSnap</Text>
      <Text style={styles.subtitle}>Smart City Issue Reporting</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Create account</Text>

        <Text style={styles.label}>Full Name</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder="As per IC"
          style={styles.input}
          placeholderTextColor="#FFFFFF88"
        />

        <Text style={styles.label}>IC Number</Text>
        <TextInput
          value={icNumber}
          onChangeText={handleIcChange}
          placeholder="e.g. 990101-14-5678"
          style={styles.input}
          keyboardType="numeric"
          placeholderTextColor="#FFFFFF88"
        />
        {icNumber.length > 0 && !icIsValid && (
          <Text style={styles.errorText}>Invalid IC format. Example: 990101-01-1234</Text>
        )}

        <Text style={styles.label}>Scan IC</Text>
        <View style={styles.row}>
          <ScanButton
            label={icFrontUri ? 'Front captured' : 'Scan front'}
            onPress={() => captureIcImage('front')}
            filled={!!icFrontUri}
          />
          <ScanButton
            label={icBackUri ? 'Back captured' : 'Scan back'}
            onPress={() => captureIcImage('back')}
            filled={!!icBackUri}
          />
        </View>

        {(icFrontUri || icBackUri) && (
          <View style={styles.icPreviewRow}>
            {icFrontUri && (
              <View style={styles.icPreviewItem}>
                <Image source={{ uri: icFrontUri }} style={styles.icPreviewImage} />
                <Text style={styles.icPreviewLabel}>Front</Text>
              </View>
            )}
            {icBackUri && (
              <View style={styles.icPreviewItem}>
                <Image source={{ uri: icBackUri }} style={styles.icPreviewImage} />
                <Text style={styles.icPreviewLabel}>Back</Text>
              </View>
            )}
          </View>
        )}

        <TouchableOpacity
          style={[styles.primaryButton, !canSubmit && styles.buttonDisabled]}
          disabled={!canSubmit}
          onPress={handleSubmit}
        >
          {isLoading ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>Sign up</Text>
          )}
        </TouchableOpacity>

        <TouchableOpacity style={styles.textLinkButton} onPress={onGoToLogIn}>
          <Text style={styles.textLinkButtonText}>Already have an account? Log in</Text>
        </TouchableOpacity>

        <Text style={styles.helperText}>
          Your identity is used to prevent spam and ensure accountable reporting.
        </Text>
      </View>
    </View>
  );
};

interface ScanButtonProps {
  label: string;
  onPress(): void;
  filled?: boolean;
}

const ScanButton: React.FC<ScanButtonProps> = ({ label, onPress, filled }) => (
  <TouchableOpacity
    onPress={onPress}
    style={[styles.outlineButton, filled && styles.outlineButtonFilled]}
  >
    <Text style={[styles.outlineButtonText, filled && styles.outlineButtonTextFilled]}>
      {label}
    </Text>
  </TouchableOpacity>
);

// ================== Home Screen ==================

interface HomeScreenProps {
  user: User;
  onStartReport(): void;
}

const HomeScreen: React.FC<HomeScreenProps> = ({ user, onStartReport }) => {
  return (
    <View style={styles.screen}>
      <Text style={styles.appTitle}>OneSnap</Text>
      <Text style={styles.welcomeText}>Welcome, {user.name} !</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>Report an issue</Text>
        <Text style={styles.helperText}>
          Snap once, we handle the rest. Severity and GPS are attached automatically.
        </Text>

        <TouchableOpacity style={styles.primaryButton} onPress={onStartReport}>
          <Text style={styles.primaryButtonText}>Start new report</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

// ================== Report Type Selection ==================

interface ReportTypeScreenProps {
  onSelectType(type: ReportType): void;
  onBack(): void;
}

const ReportTypeScreen: React.FC<ReportTypeScreenProps> = ({ onSelectType, onBack }) => {
  return (
    <View style={styles.screen}>
      <Text style={styles.appTitle}>New Report</Text>

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>What are you reporting?</Text>

        <TypeButton label="Pothole" onPress={() => onSelectType('POTHOLE')} />
        <TypeButton label="Excessive Trash Disposal " onPress={() => onSelectType('TRASH')} />
        <TypeButton label="Public Facility Vandalism" onPress={() => onSelectType('VANDALISM')} />

        <TouchableOpacity style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

interface TypeButtonProps {
  label: string;
  onPress(): void;
}

const TypeButton: React.FC<TypeButtonProps> = ({ label, onPress }) => (
  <TouchableOpacity style={styles.typeButton} onPress={onPress}>
    <Text style={styles.typeButtonText}>{label}</Text>
  </TouchableOpacity>
);

// ================== Report Capture & Submit ==================

interface ReportCaptureScreenProps {
  user: User;
  reportType: ReportType;
  onBack(): void;
  onSubmitted(report: SubmittedReport): void;
}

const DEFAULT_REGION: Region = {
  latitude: 3.139,
  longitude: 101.6869,
  latitudeDelta: 0.01,
  longitudeDelta: 0.01,
};

const ReportCaptureScreen: React.FC<ReportCaptureScreenProps> = ({
  user,
  reportType,
  onBack,
  onSubmitted,
}) => {
  const { locationService, aiModelService, reportService } = useServices();

  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);

  const [reportLocation, setReportLocation] = useState<Location | null>(null);
  const [locationLoading, setLocationLoading] = useState(true);
  const [locationError, setLocationError] = useState<string | null>(null);
  const [showMapPicker, setShowMapPicker] = useState(false);
  const [mapRegion, setMapRegion] = useState<Region>(DEFAULT_REGION);

  const readableType =
    reportType === 'POTHOLE' ? 'Pothole' : reportType === 'TRASH' ? 'Trash' : 'Vandalism';

  const fetchCurrentLocation = async () => {
    setLocationLoading(true);
    setLocationError(null);
    try {
      const loc = await locationService.getCurrentLocation();
      setReportLocation(loc);
      setMapRegion({
        latitude: loc.latitude,
        longitude: loc.longitude,
        latitudeDelta: 0.01,
        longitudeDelta: 0.01,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not get location';
      setLocationError(msg);
      setReportLocation(null);
    } finally {
      setLocationLoading(false);
    }
  };

  useEffect(() => {
    fetchCurrentLocation();
  }, []);

  const handleMapPress = async (e: {
    nativeEvent: { coordinate: { latitude: number; longitude: number } };
  }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    const address = await reverseGeocode(latitude, longitude);
    setReportLocation({ latitude, longitude, address });
  };

  const confirmMapLocation = () => {
    setShowMapPicker(false);
  };

  const captureReportPhoto = async () => {
    try {
      const response: ImagePickerResponse = await launchCamera({
        mediaType: 'photo',
        cameraType: 'back',
        quality: 0.8,
        includeBase64: true,
      });

      if (response.didCancel || !response.assets || !response.assets[0]?.uri) {
        return;
      }

      const asset = response.assets[0];
      setPhotoUri(asset.uri || null);
      setPhotoBase64(asset.base64 || null);
    } catch (e) {
      Alert.alert('Camera error', 'Unable to open camera. Please try again.');
    }
  };

  const pickReportPhotoFromLibrary = async () => {
    try {
      const response: ImagePickerResponse = await launchImageLibrary({
        mediaType: 'photo',
        quality: 0.8,
        includeBase64: true,
      });

      if (response.didCancel || !response.assets || !response.assets[0]?.uri) {
        return;
      }

      const asset = response.assets[0];
      setPhotoUri(asset.uri || null);
      setPhotoBase64(asset.base64 || null);
    } catch (e) {
      Alert.alert('Gallery error', 'Unable to open gallery. Please try again.');
    }
  };

  const handleSubmit = async () => {
    if (!photoUri || isSubmitting) return;
    try {
      setIsSubmitting(true);

      let location = reportLocation;
      if (!location) {
        try {
          location = await locationService.getCurrentLocation();
          setReportLocation(location);
        } catch (e) {
          Alert.alert(
            'Location required',
            'Please allow location or pick a spot on the map so the report includes where the issue is.'
          );
          setIsSubmitting(false);
          return;
        }
      }

      const { severity, confidence } = await aiModelService.inferSeverity(
        photoBase64 || '',
        reportType
      );
      setAiExplanation(
        `AI ranked this as ${severity.toLowerCase()} priority (confidence ${Math.round(confidence * 100)
        }%).`
      );

      if (reportType === 'VANDALISM' && severity !== 'LOW') {
        Vibration.vibrate([0, 200, 100, 200]);
        Alert.alert(
          'Vandalism detected',
          `AI detected possible vandalism with ${Math.round(confidence * 100)}% confidence.`
        );
      }

      const payload: ReportPayload = {
        reporter: user,
        type: reportType,
        photoUri,
        photoBase64: photoBase64 || undefined,
        location,
        description: description.trim(),
        severity,
        createdAt: new Date().toISOString(),
      };

      await reportService.submitReport(payload);
      Alert.alert('Report submitted', 'Thank you for improving your city.');
      const submitted: SubmittedReport = {
        ...payload,
        id: `rep-${Date.now()}`,
        status: 'PENDING',
      };
      onSubmitted(submitted);
    } catch (e) {
      Alert.alert('Error', 'Unable to submit report. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <View style={styles.screen}>
      <Text style={styles.appTitle}>Capture {readableType}</Text>

      <View style={styles.card}>
        <View style={styles.previewBox}>
          {photoUri ? (
            <Image
              source={{ uri: photoUri }}
              style={styles.previewImage}
            />
          ) : (
            <Text style={styles.previewPlaceholder}>No photo yet</Text>
          )}
        </View>

        <TouchableOpacity style={styles.primaryButton} onPress={captureReportPhoto}>
          <Text style={styles.primaryButtonText}>
            {photoUri ? 'Retake photo' : 'Snap photo'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.textLinkButton} onPress={pickReportPhotoFromLibrary}>
          <Text style={styles.textLinkButtonText}>Or choose from gallery</Text>
        </TouchableOpacity>

        <Text style={styles.label}>Describe the issue</Text>
        <TextInput
          value={description}
          onChangeText={setDescription}
          style={styles.textArea}
          placeholder="Eg. Large pothole on left lane causing cars to swerve."
          placeholderTextColor="#FFFFFF88"
          multiline
        />

        <Text style={styles.label}>Report location</Text>
        {locationLoading ? (
          <View style={styles.locationRow}>
            <ActivityIndicator size="small" color="#2F80ED" />
            <Text style={styles.locationText}>Getting your location…</Text>
          </View>
        ) : locationError ? (
          <View style={styles.locationRow}>
            <Text style={styles.locationError}>{locationError}</Text>
          </View>
        ) : reportLocation ? (
          <View style={styles.locationRow}>
            <Text style={styles.locationText} numberOfLines={2}>
              {reportLocation.address ?? `${reportLocation.latitude.toFixed(5)}, ${reportLocation.longitude.toFixed(5)}`}
            </Text>
          </View>
        ) : null}
        <View style={styles.locationButtons}>
          <TouchableOpacity
            style={styles.locationButton}
            onPress={fetchCurrentLocation}
            disabled={locationLoading}
          >
            <Text style={styles.locationButtonText}>Use my current location</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.locationButton}
            onPress={() => setShowMapPicker(true)}
          >
            <Text style={styles.locationButtonText}>Pick on map</Text>
          </TouchableOpacity>
        </View>

        <Modal
          visible={showMapPicker}
          animationType="slide"
          onRequestClose={() => setShowMapPicker(false)}
        >
          <View style={styles.mapContainer}>
            <View style={styles.mapHeader}>
              <Text style={styles.mapTitle}>Tap on the map to set report location</Text>
              <TouchableOpacity onPress={() => setShowMapPicker(false)}>
                <Text style={styles.mapCancel}>Cancel</Text>
              </TouchableOpacity>
            </View>
            <MapView
              style={styles.map}
              region={mapRegion}
              onRegionChangeComplete={setMapRegion}
              onPress={handleMapPress}
              showsUserLocation
            >
              {reportLocation && (
                <Marker
                  coordinate={{
                    latitude: reportLocation.latitude,
                    longitude: reportLocation.longitude,
                  }}
                  draggable
                  onDragEnd={(e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
                    const { latitude, longitude } = e.nativeEvent.coordinate;
                    setReportLocation((prev) =>
                      prev ? { ...prev, latitude, longitude } : { latitude, longitude }
                    );
                  }}
                />
              )}
            </MapView>
            <View style={styles.mapFooter}>
              {reportLocation && (
                <Text style={styles.mapCoords} numberOfLines={1}>
                  {reportLocation.latitude.toFixed(5)}, {reportLocation.longitude.toFixed(5)}
                  {reportLocation.address ? ` · ${reportLocation.address}` : ''}
                </Text>
              )}
              <TouchableOpacity style={styles.primaryButton} onPress={confirmMapLocation}>
                <Text style={styles.primaryButtonText}>Confirm location</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        <TouchableOpacity
          style={[styles.primaryButton, (!photoUri || isSubmitting) && styles.buttonDisabled]}
          disabled={!photoUri || isSubmitting}
          onPress={handleSubmit}
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.primaryButtonText}>Submit report</Text>
          )}
        </TouchableOpacity>

        {aiExplanation && <Text style={styles.helperText}>{aiExplanation}</Text>}

        <TouchableOpacity style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

// ================== My Reports Screen ==================

interface MyReportsScreenProps {
  reports: SubmittedReport[];
  onBack(): void;
}

const MyReportsScreen: React.FC<MyReportsScreenProps> = ({ reports, onBack }) => {
  return (
    <View style={styles.screen}>
      <Text style={styles.appTitle}>My reports</Text>
      <ScrollView
        style={styles.myReportsScroll}
        contentContainerStyle={[styles.card, styles.myReportsScrollContent]}
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
        {reports.length === 0 ? (
          <Text style={styles.helperText}>You have not submitted any reports yet.</Text>
        ) : (
          reports.map((report) => {
            const created = new Date(report.createdAt);
            const readableType =
              report.type === 'POTHOLE'
                ? 'Pothole'
                : report.type === 'TRASH'
                  ? 'Trash'
                  : 'Vandalism';
            return (
              <View key={report.id} style={styles.reportItem}>
                <View style={styles.reportRow}>
                  <Text style={styles.reportTitle}>{readableType}</Text>
                  <View
                    style={[
                      styles.statusBadge,
                      report.status === 'PENDING'
                        ? styles.statusPending
                        : report.status === 'IN_PROGRESS'
                          ? styles.statusInProgress
                          : styles.statusResolved,
                    ]}
                  >
                    <Text style={styles.statusBadgeText}>
                      {report.status === 'PENDING'
                        ? 'Pending'
                        : report.status === 'IN_PROGRESS'
                          ? 'In progress'
                          : 'Resolved'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.reportMeta}>
                  {created.toLocaleDateString()} • {created.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
                <Text style={styles.reportMeta}>
                  Severity Level from AI: {report.severity.charAt(0) + report.severity.slice(1).toLowerCase()}
                </Text>
                <Text style={styles.reportMeta}>
                  Location:{' '}
                  {report.location.address
                    ? report.location.address
                    : `${report.location.latitude.toFixed(5)}, ${report.location.longitude.toFixed(5)}`}
                </Text>
                {report.description ? (
                  <Text style={styles.reportMeta} numberOfLines={2}>
                    "{report.description}"
                  </Text>
                ) : null}
              </View>
            );
          })
        )}
        <TouchableOpacity style={styles.secondaryButton} onPress={onBack}>
          <Text style={styles.secondaryButtonText}>Back</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
};

// ================== Bottom Navigation ==================

interface BottomNavProps {
  activeTab: 'HOME' | 'REPORT' | 'MY_REPORTS';
  onPressHome(): void;
  onPressReport(): void;
  onPressMyReports(): void;
}

const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onPressHome,
  onPressReport,
  onPressMyReports,
}) => {
  return (
    <View style={styles.bottomNav}>
      <TouchableOpacity
        style={[
          styles.bottomNavItem,
          activeTab === 'HOME' && styles.bottomNavItemActive,
        ]}
        onPress={onPressHome}
        accessibilityLabel="Home"
      >
        <Text
          style={[
            styles.bottomNavText,
            activeTab === 'HOME' && styles.bottomNavTextActive,
          ]}
        >
          Home
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.bottomNavItem,
          activeTab === 'REPORT' && styles.bottomNavItemActive,
        ]}
        onPress={onPressReport}
        accessibilityLabel="New report"
      >
        <Text
          style={[
            styles.bottomNavText,
            activeTab === 'REPORT' && styles.bottomNavTextActive,
          ]}
        >
          Report
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={[
          styles.bottomNavItem,
          activeTab === 'MY_REPORTS' && styles.bottomNavItemActive,
        ]}
        onPress={onPressMyReports}
        accessibilityLabel="My reports"
      >
        <Text
          style={[
            styles.bottomNavText,
            activeTab === 'MY_REPORTS' && styles.bottomNavTextActive,
          ]}
        >
          My reports
        </Text>
      </TouchableOpacity>
    </View>
  );
};

// ================== Styles ==================

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0B1721',
  },
  appShell: {
    flex: 1,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 8,
    minHeight: 48,
  },
  topBarSpacer: {
    width: 40,
    height: 40,
  },
  settingsIconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  settingsIcon: {
    fontSize: 24,
    color: '#A0B4C8',
  },
  screenContent: {
    flex: 1,
  },
  settingsModalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: 24,
  },
  settingsModalCard: {
    backgroundColor: '#101C28',
    borderRadius: 16,
    padding: 20,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 8,
  },
  settingsModalTitle: {
    fontSize: 18,
    fontWeight: '600',
    fontFamily: 'sans-serif',
    color: '#FFFFFF',
    marginBottom: 16,
  },
  settingsModalOption: {
    paddingVertical: 14,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E2A36',
  },
  settingsModalOptionText: {
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#E6EDF4',
  },
  settingsModalOptionDanger: {
    color: '#FF6B6B',
  },
  screen: {
    flex: 1,
    paddingHorizontal: 20,
    paddingTop: 24,
  },
  appTitle: {
    fontSize: 28,
    fontWeight: '700',
    fontFamily: 'sans-serif',
    color: '#FFFFFF',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#A0B4C8',
    marginBottom: 16,
  },
  welcomeText: {
    fontSize: 22,
    fontFamily: 'sans-serif',
    color: '#FFFFFF',
    marginBottom: 16,
  },
  myReportsScroll: {
    flex: 1,
  },
  myReportsScrollContent: {
    paddingBottom: 32,
  },
  card: {
    backgroundColor: '#101C28',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    fontFamily: 'sans-serif',
    color: '#FFFFFF',
    marginBottom: 12,
  },
  label: {
    fontSize: 16,
    fontFamily: 'sans-serif',
    color: '#A0B4C8',
    marginTop: 8,
    marginBottom: 4,
  },
  input: {
    backgroundColor: '#1B2836',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 16,
    fontFamily: 'sans-serif',
  },
  row: {
    flexDirection: 'row',
    gap: 8,
    marginVertical: 8,
  },
  primaryButton: {
    backgroundColor: '#2F80ED',
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 12,
  },
  primaryButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 16,
    fontFamily: 'sans-serif',
  },
  secondaryButton: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#32465B',
    paddingVertical: 10,
    alignItems: 'center',
    marginTop: 10,
  },
  secondaryButtonText: {
    color: '#A0B4C8',
    fontSize: 15,
    fontFamily: 'sans-serif',
  },
  outlineButton: {
    flex: 1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#32465B',
    paddingVertical: 10,
    alignItems: 'center',
    marginRight: 4,
  },
  outlineButtonFilled: {
    backgroundColor: '#1B2836',
    borderColor: '#2F80ED',
  },
  outlineButtonText: {
    color: '#A0B4C8',
    fontSize: 14,
    fontFamily: 'sans-serif',
  },
  outlineButtonTextFilled: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  typeButton: {
    backgroundColor: '#1B2836',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 10,
    marginTop: 10,
  },
  typeButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontFamily: 'sans-serif',
  },
  helperText: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#7F92A7',
    marginTop: 8,
  },
  textLinkButton: {
    alignItems: 'center',
    marginTop: 6,
  },
  textLinkButtonText: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#A0B4C8',
    textDecorationLine: 'underline',
  },
  textArea: {
    backgroundColor: '#1B2836',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#FFFFFF',
    fontSize: 15,
    fontFamily: 'sans-serif',
    minHeight: 80,
    textAlignVertical: 'top',
    marginTop: 8,
  },
  errorText: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#FF6B6B',
    marginTop: 4,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 8,
    gap: 8,
  },
  locationText: {
    fontSize: 14,
    fontFamily: 'sans-serif',
    color: '#E6EDF4',
    flex: 1,
  },
  locationError: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#FF6B6B',
  },
  locationButtons: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  locationButton: {
    flex: 1,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: '#1B2836',
    alignItems: 'center',
  },
  locationButtonText: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#2F80ED',
  },
  mapContainer: {
    flex: 1,
    backgroundColor: '#0B1721',
  },
  mapHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E2A36',
  },
  mapTitle: {
    fontSize: 14,
    fontFamily: 'sans-serif',
    color: '#A0B4C8',
    flex: 1,
  },
  mapCancel: {
    fontSize: 15,
    fontFamily: 'sans-serif',
    color: '#2F80ED',
  },
  map: {
    flex: 1,
    width: '100%',
  },
  mapFooter: {
    padding: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1E2A36',
    backgroundColor: '#0B1721',
  },
  mapCoords: {
    fontSize: 12,
    fontFamily: 'sans-serif',
    color: '#7F92A7',
    marginBottom: 10,
  },
  previewBox: {
    height: 180,
    borderRadius: 12,
    backgroundColor: '#1B2836',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  previewPlaceholder: {
    color: '#7F92A7',
    fontFamily: 'sans-serif',
  },
  previewImage: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  icPreviewRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    marginTop: 8,
    marginBottom: 4,
  },
  icPreviewItem: {
    marginRight: 10,
    alignItems: 'center',
  },
  icPreviewImage: {
    width: 80,
    height: 50,
    borderRadius: 8,
    backgroundColor: '#1B2836',
  },
  icPreviewLabel: {
    marginTop: 4,
    fontSize: 11,
    fontFamily: 'sans-serif',
    color: '#A0B4C8',
  },
  reportItem: {
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E2A36',
  },
  reportRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  reportTitle: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: 'sans-serif',
    color: '#FFFFFF',
  },
  reportMeta: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#A0B4C8',
  },
  statusBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  statusBadgeText: {
    fontSize: 12,
    fontFamily: 'sans-serif',
    color: '#0B1721',
    fontWeight: '600',
  },
  statusPending: {
    backgroundColor: '#F2C94C',
  },
  statusInProgress: {
    backgroundColor: '#2D9CDB',
  },
  statusResolved: {
    backgroundColor: '#27AE60',
  },
  bottomNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 24,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#1E2A36',
    backgroundColor: '#0B1721',
  },
  bottomNavItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    borderRadius: 999,
  },
  bottomNavItemActive: {
    backgroundColor: 'rgba(47,128,237,0.15)',
  },
  bottomNavText: {
    fontSize: 13,
    fontFamily: 'sans-serif',
    color: '#7F92A7',
  },
  bottomNavTextActive: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});

export default App;