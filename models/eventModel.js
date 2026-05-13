import mongoose from "mongoose";

const eventSchema = new mongoose.Schema(
  {
    mapping_id: {
      type: String,
      required: true,
      unique: true,
    },
    Event_ID: {
      type: String,
      required: true,
      unique: true,
    },
    Event_Name: {
      type: String,
      required: true,
    },
    Event_DateTime: {
      type: Date,
      required: true,
    },
    Venue: String,
    URL: {
      type: String,
      required: true,
    },
    Zone: {
      type: String,
      default: "none",
    },
    Available_Seats: {
      type: Number,
      default: 0,
    },
    Skip_Scraping: {
      type: Boolean,
      default: true,
    },
    eventType: {
      type: String,
      enum: ["NFL", "MLB", "NHL", "NBA", "MLS", "Other", null],
      default: null,
    },
    inHandDate: {
      type: Date,
      default: Date.now,
    },
    priceIncreasePercentage: {
      type: Number,
      default: 25, // Default 25% markup
    },
    standardMarkupAdjustment: {
      type: Number,
      default: 0, // +/- offset on top of scraper default for STANDARD tickets
    },
    resaleMarkupAdjustment: {
      type: Number,
      default: 0, // +/- offset on top of scraper default for RESALE tickets
    },
    includeStandardSeats: {
      type: Boolean,
      default: true, // Include STANDARD seats in CSV export
    },
    includeResaleSeats: {
      type: Boolean,
      default: true, // Include RESALE seats in CSV export
    },
    Last_Updated: {
      type: Date,
      default: Date.now,
    },
    metadata: {
      lastUpdate: String,
      iterationNumber: Number,
      scrapeStartTime: Date,
      scrapeEndTime: Date,
      inHandDate: Date,
      scrapeDurationSeconds: Number,
      totalRunningTimeMinutes: Number,
      ticketStats: {
        totalTickets: Number,
        ticketCountChange: Number,
        previousTicketCount: Number,
      },
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
eventSchema.index({ URL: 1 }, { unique: true });
eventSchema.index({ Last_Updated: 1 }); // Index for CSV generation filtering
eventSchema.index({ eventType: 1 });

export const Event = mongoose.models.Event || mongoose.model("Event", eventSchema);
