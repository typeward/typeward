/**
 * Hand-rolled Supabase schema types — only the columns the app actually
 * reads. Billing is owned by the Typeward website (Stripe checkout +
 * webhook), so the Stripe columns (`stripe_price_id`, `stripe_customer_id`,
 * `stripe_subscription_id`) are deliberately omitted here even though they
 * exist on the live tables; the app never selects them. If you regenerate
 * from the schema (`supabase gen types typescript --linked`), drop the
 * Stripe columns again to keep the app's model billing-free.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface Database {
  public: {
    Tables: {
      plans: {
        Row: {
          id: string;
          name: string;
          price_cents: number;
          currency: string;
          billing_interval: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          name: string;
          price_cents?: number;
          currency?: string;
          billing_interval?: string | null;
        };
        Update: {
          id?: string;
          name?: string;
          price_cents?: number;
          currency?: string;
          billing_interval?: string | null;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          plan_id: string;
          status: string;
          current_period_end: string | null;
          cancel_at_period_end: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          user_id: string;
          plan_id: string;
          status: string;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
        };
        Update: {
          user_id?: string;
          plan_id?: string;
          status?: string;
          current_period_end?: string | null;
          cancel_at_period_end?: boolean;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          id: string;
          display_name: string | null;
          marketing_opt_in: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          display_name?: string | null;
          marketing_opt_in?: boolean;
        };
        Update: {
          id?: string;
          display_name?: string | null;
          marketing_opt_in?: boolean;
        };
        Relationships: [];
      };
      entitlements_map: {
        Row: {
          plan_id: string;
          feature_key: string;
          value: string;
        };
        Insert: {
          plan_id: string;
          feature_key: string;
          value: string;
        };
        Update: {
          plan_id?: string;
          feature_key?: string;
          value?: string;
        };
        Relationships: [];
      };
      shared_templates: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          description: string | null;
          manifest: Json;
          files_blob_url: string | null;
          visibility: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          owner_id: string;
          name: string;
          description?: string | null;
          manifest: Json;
          files_blob_url?: string | null;
          visibility?: string;
        };
        Update: {
          owner_id?: string;
          name?: string;
          description?: string | null;
          manifest?: Json;
          files_blob_url?: string | null;
          visibility?: string;
        };
        Relationships: [];
      };
      shared_template_grants: {
        Row: {
          template_id: string;
          grantee_user_id: string;
          can_edit: boolean;
          created_at: string;
        };
        Insert: {
          template_id: string;
          grantee_user_id: string;
          can_edit?: boolean;
        };
        Update: {
          template_id?: string;
          grantee_user_id?: string;
          can_edit?: boolean;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_entitlements: {
        Args: Record<string, never>;
        // plan_id added by the 20260706 migration; optional so cached
        // snapshots and a not-yet-migrated backend still typecheck.
        Returns: Array<{ plan_id?: string; feature_key: string; value: string }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
