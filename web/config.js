// Connection details for the Supabase project that stores the trackers (see README, "Setting up
// the website"). Both values are safe to publish: the database only lets the website call the
// functions in supabase/schema.sql, and every one of those needs a tracker's code.
export default {
  supabaseUrl: "",   // e.g. "https://abcdefghijklmnop.supabase.co"
  supabaseKey: "",   // the project's publishable key ("sb_publishable_...") or legacy anon key
};
