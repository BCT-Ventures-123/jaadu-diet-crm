// The ONLY place to tune the Low / Medium / High risk display. Points are added up,
// then compared with `levels`. Display only: this does not affect lead routing.
module.exports = {
  levels: { medium: 20, high: 45 },

  pincodeRto: {
    minShipped: 5,           // ignore pincodes with less history than this
    mediumRate: 0.15, mediumPoints: 20,
    highRate: 0.30, highPoints: 35,
  },
  address: {
    minChars: 25,            // shorter than this = incomplete
    shortPoints: 10,
    missingLandmarkPoints: 10,
    badPinPoints: 25,        // PIN missing or not 6 digits
    landmarkWords: /\b(near|opp|opposite|behind|next to|beside|landmark|chowk|mandir|temple|school|hospital|market|colony|nagar|road|marg|street|gali|lane|sector|block|flat|floor|house|plot|apartment|society|building)\b/i,
  },
  customerHistory: {         // previous RTOs / refusals for the same phone
    onePoints: 30,
    twoOrMorePoints: 45,
  },
  repeatOrders: {            // other orders from the same phone shortly before this one
    windowHours: 72,
    onePoints: 15,
    twoOrMorePoints: 25,
  },
  orderValue: {
    mediumValue: 1500, mediumPoints: 10,
    highValue: 3000, highPoints: 20,
  },
  phone: {
    invalidPoints: 30,       // not a valid 10-digit Indian mobile
  },

  legend: [
    { level: 'Low', color: 'green', text: 'Few or no warning signs.' },
    { level: 'Medium', color: 'amber', text: 'Some warning signs. Confirm address and intent carefully.' },
    { level: 'High', color: 'red', text: 'Several warning signs (RTO-prone area, past refusals, weak address or phone).' },
  ],
};
