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
  // Cover-listings rule: for each unsplittable pack (custom_split == quantity)
  // with cost data, emit sibling inventory_ids at each smaller cover size,
  // priced so a single sale of that size fully covers the pack's total
  // cost. Parent and siblings share the same physical seats — Automatiq
  // treats the CSV as authoritative, so when the parent's seats disappear
  // in the next scrape, all siblings vanish with it. When enabled, runs
  // after all other filters at CSV-emit time.
  coverListings: {
    enabled: { type: Boolean, default: false },
  },
  // Combined-listings rule: within (event, section, row), for every
  // contiguous run of 2+ listings whose seat numbers touch with no gap,
  // emit synthetic listings that concatenate the components (every k-way
  // sub-run capped at 8 seats). Originals stay unchanged. Synthetic id
  // is derived from the sorted component ids, so any component change on
  // the next scrape vanishes the synthetic. Priced at total component
  // face × 1.15 / combined_qty so a single sale recoups every face + 15%.
  combinedListings: {
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