'use client';
import React from 'react';
import { AlertCircle, CheckCircle, Hash, Tag, Calendar, Clock, MapPin, Ticket, Minus, Plus, Globe } from 'lucide-react';
import { EVENT_TYPES } from '@/lib/venueToSport';

// Explicit validation status variants instead of boolean props
const FieldStatus = {
  Untouched: ({ children }: { children: React.ReactNode }) => children,
  
  Valid: ({ children }: { children: React.ReactNode }) => (
    <div className="relative">
      {children}
      <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
        <CheckCircle className="h-5 w-5 text-green-500" />
      </div>
    </div>
  ),
  
  Invalid: ({ children, error }: { children: React.ReactNode; error?: string }) => (
    <div>
      <div className="relative">
        {children}
        <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
          <AlertCircle className="h-5 w-5 text-red-500" />
        </div>
      </div>
      {error && (
        <p className="mt-1 text-sm text-red-600 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
    </div>
  )
};

// Compound component for form fields
export const FormField = {
  Root: ({ children }: { children: React.ReactNode }) => (
    <div className="space-y-1">
      {children}
    </div>
  ),
  
  Label: ({ htmlFor, required, children }: { 
    htmlFor: string; 
    required?: boolean; 
    children: React.ReactNode 
  }) => (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-gray-700">
      {children}
      {required && <span className="text-red-500 ml-1">*</span>}
    </label>
  ),
  
  Input: ({ 
    status, 
    error, 
    icon, 
    ...props 
  }: { 
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    icon?: React.ReactNode;
  } & React.InputHTMLAttributes<HTMLInputElement>) => {
    const getStatusClass = () => {
      switch (status) {
        case 'invalid':
          return 'border-red-500 bg-red-50';
        case 'valid':
          return 'border-green-500 bg-green-50';
        default:
          return 'border-gray-300';
      }
    };

    const input = (
      <input
        {...props}
        className={`w-full ${icon ? 'pl-10' : 'pl-4'} pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors ${getStatusClass()}`}
      />
    );

    const inputWithIcon = icon ? (
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          {icon}
        </div>
        {input}
      </div>
    ) : input;

    // Use explicit status variants
    switch (status) {
      case 'valid':
        return <FieldStatus.Valid>{inputWithIcon}</FieldStatus.Valid>;
      case 'invalid':
        return <FieldStatus.Invalid error={error}>{inputWithIcon}</FieldStatus.Invalid>;
      default:
        return <FieldStatus.Untouched>{inputWithIcon}</FieldStatus.Untouched>;
    }
  },
  
  Checkbox: ({ 
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    status, 
    ...props 
  }: { 
    status: 'untouched' | 'valid' | 'invalid';
  } & React.InputHTMLAttributes<HTMLInputElement>) => (
    <input
      {...props}
      type="checkbox"
      className="h-4 w-4 text-blue-600 focus:ring-blue-500 border-gray-300 rounded"
    />
  ),
  
  Help: ({ children }: { children: React.ReactNode }) => (
    <p className="text-xs text-gray-500">
      {children}
    </p>
  )
};

// Specific field variants with proper icons
export const EventFormFields = {
  URL: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Event URL</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="url"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="https://www.ticketmaster.com (.ca/.co.uk)/event/..."
        icon={<Globe className="h-5 w-5 text-gray-400" />}
      />
    </FormField.Root>
  ),

  EventID: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Event ID</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="text"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="Enter event ID"
        icon={<Hash className="h-5 w-5 text-gray-400" />}
      />
      <FormField.Help>This ID will be extracted automatically if present in the URL</FormField.Help>
    </FormField.Root>
  ),

  EventName: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Event Name</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="text"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="Event Name"
        icon={<Tag className="h-5 w-5 text-gray-400" />}
      />
    </FormField.Root>
  ),

  DateTime: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Event Date & Time</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="datetime-local"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        icon={<Calendar className="h-5 w-5 text-gray-400" />}
      />
    </FormField.Root>
  ),

  InHandDate: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>In-Hand Date</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="date"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        icon={<Clock className="h-5 w-5 text-gray-400" />}
      />
      <FormField.Help>When tickets will be available/in hand</FormField.Help>
    </FormField.Root>
  ),

  Venue: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Venue</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="text"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="Enter venue name"
        icon={<MapPin className="h-5 w-5 text-gray-400" />}
      />
    </FormField.Root>
  ),

  Zone: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Zone</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="text"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="Enter zone"
        icon={<Ticket className="h-5 w-5 text-gray-400" />}
      />
    </FormField.Root>
  ),

  AvailableSeats: ({ name, value, onChange, disabled }: {
    name: string;
    value: number;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name}>Available Seats</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="number"
        min="0"
        value={value}
        status="untouched"
        onChange={onChange}
        disabled={disabled}
      />
      <FormField.Help>Initial number of available seats (if known)</FormField.Help>
    </FormField.Root>
  ),

  MappingID: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required>Event Mapping ID</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="text"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="Enter event mapping ID"
        icon={<Hash className="h-5 w-5 text-gray-400" />}
      />
    </FormField.Root>
  ),

  PriceIncrease: ({ name, value, status, error, onChange, onBlur, disabled }: {
    name: string;
    value: number;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <FormField.Root>
      <FormField.Label htmlFor={name} required> Default Markup %</FormField.Label>
      <FormField.Input
        id={name}
        name={name}
        type="number"
        min="0"
        step="0.01"
        value={value}
        status={status}
        error={error}
        onChange={onChange}
        onBlur={onBlur}
        disabled={disabled}
        placeholder="Enter percentage increase"
        icon={<Tag className="h-5 w-5 text-gray-400" />}
      />
      <FormField.Help>Base markup % the scraper applies to all prices</FormField.Help>
    </FormField.Root>
  ),

  MarkupAdjustments: ({
    standardAdj,
    resaleAdj,
    brokerAdj,
    defaultPct,
    onStandardChange,
    onResaleChange,
    onBrokerChange,
    disabled,
  }: {
    standardAdj: number;
    resaleAdj: number;
    brokerAdj: number;
    defaultPct: number;
    onStandardChange: (val: number) => void;
    onResaleChange: (val: number) => void;
    onBrokerChange: (val: number) => void;
    disabled?: boolean;
  }) => {
    const step = 1;
    const effectiveStandard = defaultPct + standardAdj;
    const effectiveResale = defaultPct + resaleAdj;
    const effectiveBroker = defaultPct + (brokerAdj !== 0 ? brokerAdj : resaleAdj);

    const colorClass = (adj: number) =>
      adj > 0 ? 'text-red-600 font-bold' : adj < 0 ? 'text-blue-600 font-bold' : 'text-slate-400';

    return (
      <div className="col-span-2">
        <div className="block text-sm font-medium text-gray-700 mb-1">
          CSV Price Adjustments{' '}
          <span className="text-xs font-normal text-gray-400">(on top of scraper default)</span>
        </div>
        <div className="grid grid-cols-3 gap-3 p-4 rounded-lg border border-gray-200 bg-gray-50">
          {/* Standard */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Standard</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onStandardChange(standardAdj - step)}
                disabled={disabled}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                aria-label="Decrease standard adjustment"
              >
                <Minus size={13} />
              </button>
              <input
                type="number"
                value={standardAdj}
                onChange={e => onStandardChange(Number(e.target.value))}
                disabled={disabled}
                className="w-16 text-center border border-gray-300 rounded-md py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                step={step}
              />
              <button
                type="button"
                onClick={() => onStandardChange(standardAdj + step)}
                disabled={disabled}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                aria-label="Increase standard adjustment"
              >
                <Plus size={13} />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Effective: <span className={colorClass(standardAdj)}>{effectiveStandard > 0 ? '+' : ''}{effectiveStandard}%</span>
            </p>
          </div>

          {/* Resale */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Resale</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onResaleChange(resaleAdj - step)}
                disabled={disabled}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                aria-label="Decrease resale adjustment"
              >
                <Minus size={13} />
              </button>
              <input
                type="number"
                value={resaleAdj}
                onChange={e => onResaleChange(Number(e.target.value))}
                disabled={disabled}
                className="w-16 text-center border border-gray-300 rounded-md py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                step={step}
              />
              <button
                type="button"
                onClick={() => onResaleChange(resaleAdj + step)}
                disabled={disabled}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                aria-label="Increase resale adjustment"
              >
                <Plus size={13} />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Effective: <span className={colorClass(resaleAdj)}>{effectiveResale > 0 ? '+' : ''}{effectiveResale}%</span>
            </p>
          </div>

          {/* Broker */}
          <div className="space-y-1">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Broker</p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onBrokerChange(brokerAdj - step)}
                disabled={disabled}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                aria-label="Decrease broker adjustment"
              >
                <Minus size={13} />
              </button>
              <input
                type="number"
                value={brokerAdj}
                onChange={e => onBrokerChange(Number(e.target.value))}
                disabled={disabled}
                className="w-16 text-center border border-gray-300 rounded-md py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                step={step}
              />
              <button
                type="button"
                onClick={() => onBrokerChange(brokerAdj + step)}
                disabled={disabled}
                className="w-8 h-8 flex items-center justify-center rounded-md border border-gray-300 bg-white hover:bg-gray-100 disabled:opacity-40 transition-colors"
                aria-label="Increase broker adjustment"
              >
                <Plus size={13} />
              </button>
            </div>
            <p className="text-xs text-gray-500">
              Effective: <span className={colorClass(brokerAdj !== 0 ? brokerAdj : resaleAdj)}>{effectiveBroker > 0 ? '+' : ''}{effectiveBroker}%</span>
            </p>
          </div>
        </div>
        <p className="mt-1 text-xs text-gray-400">These adjustments are applied at CSV generation time on top of the scraper default. Broker = listings tagged &ldquo;resale broker&rdquo; (falls back to Resale if 0).</p>
      </div>
    );
  },

  SkipScraping: ({ name, checked, onChange, disabled }: {
    name: string;
    checked: boolean;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
  }) => (
    <div className="flex items-center">
      <FormField.Checkbox
        id={name}
        name={name}
        status="untouched"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <FormField.Label htmlFor={name}>
        <span className="ml-2 text-sm text-gray-700">Initially Paused (Skip Scraping)</span>
      </FormField.Label>
    </div>
  ),

  EventType: ({ name, value, status, error, onChange, onBlur, disabled, autoDetected }: {
    name: string;
    value: string;
    status: 'untouched' | 'valid' | 'invalid';
    error?: string;
    onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
    onBlur: (e: React.FocusEvent<HTMLSelectElement>) => void;
    disabled?: boolean;
    autoDetected?: boolean;
  }) => {
    const borderClass = status === 'invalid'
      ? 'border-red-500 bg-red-50'
      : 'border-gray-300';
    const helpText = autoDetected && value
      ? 'Auto-detected from venue — change if wrong'
      : 'Required before scraping can start';
    return (
      <FormField.Root>
        <FormField.Label htmlFor={name} required>Event Type</FormField.Label>
        <select
          id={name}
          name={name}
          value={value}
          onChange={onChange}
          onBlur={onBlur}
          disabled={disabled}
          className={`w-full px-4 py-2 text-sm border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors bg-white ${borderClass} disabled:bg-gray-50 disabled:text-gray-500`}
        >
          <option value="">Select a type…</option>
          {EVENT_TYPES.map(t => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
        {status === 'invalid' && error ? (
          <p className="mt-1 text-sm text-red-600 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" aria-hidden="true" />
            {error}
          </p>
        ) : (
          <FormField.Help>{helpText}</FormField.Help>
        )}
      </FormField.Root>
    );
  }
};