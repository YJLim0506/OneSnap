import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const firebaseConfig = {
    apiKey: "AIzaSyDOCMUKV4rfSVLGSiC3YZbwxVG4_At9Q70",
    authDomain: "onesnap-03142026.firebaseapp.com",
    projectId: "onesnap-03142026",
    storageBucket: "onesnap-03142026.firebasestorage.app",
    messagingSenderId: "674746413326",
    appId: "1:674746413326:web:e4e27f32567b84e237a75f",
    measurementId: "G-PJJYGLBX3Q"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Initialize and export the services you need
export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);