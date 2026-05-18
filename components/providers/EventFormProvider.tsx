'use client';
import React, { createContext, useContext, useState, ReactNode } from 'react';
import { EVENT_TYPES, isValidEventType, type EventType } from '@/lib/venueToSport';

// Define explicit form states instead of multiple boolean flags
type FormState = 'idle' | 'submitting' | 'success' | 'error';

// Define field validation state without boolean proliferation  
type ValidationStatus = 'untouched' | 'valid' | 'invalid';

interface FormField {
  value: string | number | boolean;
  status: ValidationStatus;
  error?: string;
}

interface FormData {
  URL: FormField;
  Event_ID: FormField;
  Event_Name: FormField;
  Event_DateTime: FormField;
  Venue: FormField;

  Zone: FormField;
  Available_Seats: FormField;
  Skip_Scraping: FormField;
  inHandDate: FormField;
  mapping_id: FormField;
  Percentage_Increase_ListCost: FormField;
  standardMarkupAdjustment: FormField;
  resaleMarkupAdjustment: FormField;
  brokerMarkupAdjustment: FormField;
  eventType: FormField;
}

export const EVENT_TYPE_OPTIONS: EventType[] = EVENT_TYPES;

interface FormContextInterface {
  state: FormState;
  data: FormData;
  error: string;
  actions: {
    updateField: (name: keyof FormData, value: string | number | boolean) => void;
    validateField: (name: keyof FormData) => void;
    setFormState: (state: FormState) => void;
    setError: (error: string) => void;
    reset: () => void;
    validate: () => boolean;
  };
  meta: {
    isSubmitting: boolean;
    isValid: boolean;
    hasErrors: boolean;
  };
}

const FormContext = createContext<FormContextInterface | null>(null);

// Validation rules centralized instead of scattered boolean logic
const validationRules: {
  URL: (value: string) => boolean;
  Event_ID: (value: string) => boolean;
  Event_Name: (value: string) => boolean;
  Event_DateTime: (value: string) => boolean;
  Venue: (value: string) => boolean;
  Zone: (value: string) => boolean;
  Available_Seats: (value: number) => boolean;
  Skip_Scraping: (value: boolean) => boolean;
  inHandDate: (value: string) => boolean;
  mapping_id: (value: string) => boolean;
  Percentage_Increase_ListCost: (value: number) => boolean;
  standardMarkupAdjustment: (value: number) => boolean;
  resaleMarkupAdjustment: (value: number) => boolean;
  brokerMarkupAdjustment: (value: number) => boolean;
  eventType: (value: string) => boolean;
} = {
  URL: (value: string) => {
    try {
      const parsed = new URL(value);
      return /ticketmaster\.(com|ca|co\.uk)$/i.test(parsed.hostname) && parsed.pathname.includes("/event/");
    } catch {
      return false;
    }
  },
  Event_ID: (value: string) => value.length > 0,
  Event_Name: (value: string) => value.length >= 3,
  Event_DateTime: (value: string) => Boolean(value),
  Venue: (value: string) => value.length > 0,

  Zone: (value: string) => value.length > 0,
  Available_Seats: (value: number) => value >= 0,
  Skip_Scraping: () => true, // Always valid
  inHandDate: (value: string) => Boolean(value),
  mapping_id: (value: string) => value.length > 0,
  Percentage_Increase_ListCost: (value: number) => value >= 0,
  standardMarkupAdjustment: () => true,
  resaleMarkupAdjustment: () => true,
  brokerMarkupAdjustment: () => true,
  eventType: (value: string) => isValidEventType(value),
};

const errorMessages = {
  URL: "Please enter a valid Ticketmaster event URL",
  Event_ID: "Please enter a valid event ID",
  Event_Name: "Name must be at least 3 characters long",
  Event_DateTime: "Please select an event date and time",
  Venue: "Please enter the venue name",

  Zone: "Please enter a zone",
  Available_Seats: "Must be 0 or greater",
  Skip_Scraping: "",
  inHandDate: "Please select an in-hand date",
  mapping_id: "Please enter a valid event mapping ID",
  Percentage_Increase_ListCost: "Please enter a valid percentage (0 or greater)",
  standardMarkupAdjustment: "",
  resaleMarkupAdjustment: "",
  brokerMarkupAdjustment: "",
  eventType: "Pick NFL, MLB, NHL, NBA, or Other",
};

export function EventFormProvider({ children, initialData }: { 
  children: ReactNode; 
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  initialData?: Record<string, any> | null;
}) {
  const [formState, setFormState] = useState<FormState>('idle');
  const [error, setError] = useState('');

  // Initialize form data with proper structure
  const initializeFormData = (): FormData => {
    const formatDateForInput = (dateString?: string) => {
      if (!dateString) return "";
      const date = new Date(dateString);
      return date.toISOString().slice(0, 16);
    };

    return {
      URL: { value: initialData?.URL || "", status: 'untouched' },
      Event_ID: { value: initialData?.Event_ID || "", status: 'untouched' },
      Event_Name: { value: initialData?.Event_Name || "", status: 'untouched' },
      Event_DateTime: { value: formatDateForInput(initialData?.Event_DateTime), status: 'untouched' },
      Venue: { value: initialData?.Venue || "", status: 'untouched' },

      Zone: { value: initialData?.Zone || "General", status: 'untouched' },
      Available_Seats: { value: initialData?.Available_Seats || 0, status: 'untouched' },
      Skip_Scraping: { value: initialData?.Skip_Scraping !== undefined ? initialData.Skip_Scraping : true, status: 'untouched' },
      inHandDate: { value: formatDateForInput(initialData?.inHandDate), status: 'untouched' },
      mapping_id: { value: initialData?.mapping_id || "", status: 'untouched' },
      Percentage_Increase_ListCost: { value: initialData?.priceIncreasePercentage || 0, status: 'untouched' },
      standardMarkupAdjustment: { value: initialData?.standardMarkupAdjustment ?? 0, status: 'untouched' },
      resaleMarkupAdjustment: { value: initialData?.resaleMarkupAdjustment ?? 0, status: 'untouched' },
      brokerMarkupAdjustment: { value: initialData?.brokerMarkupAdjustment ?? 0, status: 'untouched' },
      eventType: { value: initialData?.eventType ?? "", status: 'untouched' },
    };
  };

  const [formData, setFormData] = useState<FormData>(initializeFormData);

  const updateField = (name: keyof FormData, value: string | number | boolean) => {
    setFormData(prev => ({
      ...prev,
      [name]: {
        value,
        status: prev[name].status === 'untouched' ? 'untouched' : validateSingleField(name, value) ? 'valid' : 'invalid',
        error: validateSingleField(name, value) ? undefined : errorMessages[name]
      }
    }));
    
    // Clear global error when user types
    if (error) setError('');
  };

  const validateSingleField = (name: keyof FormData, value: string | number | boolean) => {
    switch (name) {
      case "URL":
      case "Event_ID":
      case "Event_Name":
      case "Event_DateTime":
      case "Venue":
      case "Zone":
      case "inHandDate":
      case "mapping_id":
      case "eventType":
        return validationRules[name](value as string);
      case "Available_Seats":
      case "Percentage_Increase_ListCost":
      case "standardMarkupAdjustment":
      case "resaleMarkupAdjustment":
      case "brokerMarkupAdjustment":
        return validationRules[name](value as number);
      case "Skip_Scraping":
        return validationRules[name](value as boolean);
      default:
        return false;
    }
  };

  const validateField = (name: keyof FormData) => {
    const field = formData[name];
    const isValid = validateSingleField(name, field.value);
    
    setFormData(prev => ({
      ...prev,
      [name]: {
        ...field,
        status: isValid ? 'valid' : 'invalid',
        error: isValid ? undefined : errorMessages[name]
      }
    }));
  };

  const validate = () => {
    const updatedData = { ...formData };
    let isFormValid = true;

    Object.keys(formData).forEach(key => {
      const fieldName = key as keyof FormData;
      const field = formData[fieldName];
      const isValid = validateSingleField(fieldName, field.value);
      
      updatedData[fieldName] = {
        ...field,
        status: isValid ? 'valid' : 'invalid',
        error: isValid ? undefined : errorMessages[fieldName]
      };
      
      if (!isValid) isFormValid = false;
    });

    setFormData(updatedData);
    return isFormValid;
  };

  const reset = () => {
    setFormData(initializeFormData());
    setFormState('idle');
    setError('');
  };

  const contextValue: FormContextInterface = {
    state: formState,
    data: formData,
    error,
    actions: {
      updateField,
      validateField,
      setFormState: setFormState,
      setError,
      reset,
      validate,
    },
    meta: {
      isSubmitting: formState === 'submitting',
      isValid: Object.values(formData).every(field => field.status === 'valid' || field.status === 'untouched'),
      hasErrors: Object.values(formData).some(field => field.status === 'invalid') || Boolean(error),
    },
  };

  return (
    <FormContext.Provider value={contextValue}>
      {children}
    </FormContext.Provider>
  );
}

export function useEventForm() {
  const context = useContext(FormContext);
  if (!context) {
    throw new Error('useEventForm must be used within an EventFormProvider');
  }
  return context;
}