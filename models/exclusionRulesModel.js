import mongoose from "mongoose";

// Schema for section and row exclusions
const sectionRowExclusionSchema = new mongoose.Schema({
  section: {
    type: String,
    required: true
  },
  excludeEntireSection: {
    type: Boolean,
    default: false
  },
  excludedRows: [{
    type: String
  }]
}, { _id: false });



const exclusionRulesSchema = new mongoose.Schema({
  eventId: {
    type: String,
    required: true,
    unique: true // One exclusion rule per event (_id)
  },
  eventName: {
    type: String,
    required: true
  },
  sectionRowExclusions: [sectionRowExclusionSchema],
  // Dominated-listings rule: within (section, quantity, custom_split),
  // drop any listing whose per-seat list_price is >= a lower-row (closer
  // to field) listing. When enabled, applied at CSV-emit time in
  // csvActions.tsx after sectionRowExclusions.
  dominatedListings: {
    enabled: { type: Boolean, default: false },
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: String,
    default: 'system'
  }
}, {
  timestamps: true
});

// Index for faster lookups (eventId index already created by unique: true)
exclusionRulesSchema.index({ isActive: 1 });

// Update lastUpdated on save
exclusionRulesSchema.pre('save', function(next) {
  this.lastUpdated = new Date();
  next();
});

export const ExclusionRules = mongoose.models.ExclusionRules || mongoose.model("ExclusionRules", exclusionRulesSchema);