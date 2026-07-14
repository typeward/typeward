export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      billing_customers: {
        Row: {
          created_at: string
          stripe_customer_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          stripe_customer_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          stripe_customer_id?: string
          user_id?: string
        }
        Relationships: []
      }
      entitlements_map: {
        Row: {
          feature_key: string
          plan_id: string
          value: string
        }
        Insert: {
          feature_key: string
          plan_id: string
          value: string
        }
        Update: {
          feature_key?: string
          plan_id?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "entitlements_map_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      feedback_dedupe: {
        Row: {
          content_hash: string
          first_seen: string
        }
        Insert: {
          content_hash: string
          first_seen?: string
        }
        Update: {
          content_hash?: string
          first_seen?: string
        }
        Relationships: []
      }
      feedback_rate_limits: {
        Row: {
          count: number
          scope: string
          subject: string
          window_start: string
        }
        Insert: {
          count?: number
          scope: string
          subject: string
          window_start?: string
        }
        Update: {
          count?: number
          scope?: string
          subject?: string
          window_start?: string
        }
        Relationships: []
      }
      plan_prices: {
        Row: {
          billing_interval: string
          currency: string
          plan_id: string
          stripe_price_id: string
          unit_amount: number
        }
        Insert: {
          billing_interval: string
          currency?: string
          plan_id: string
          stripe_price_id: string
          unit_amount: number
        }
        Update: {
          billing_interval?: string
          currency?: string
          plan_id?: string
          stripe_price_id?: string
          unit_amount?: number
        }
        Relationships: [
          {
            foreignKeyName: "plan_prices_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          billing_interval: string | null
          created_at: string
          currency: string
          id: string
          name: string
          price_cents: number
          stripe_price_id: string | null
        }
        Insert: {
          billing_interval?: string | null
          created_at?: string
          currency?: string
          id: string
          name: string
          price_cents?: number
          stripe_price_id?: string | null
        }
        Update: {
          billing_interval?: string | null
          created_at?: string
          currency?: string
          id?: string
          name?: string
          price_cents?: number
          stripe_price_id?: string | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          marketing_consent_version: string | null
          marketing_opt_in: boolean
          marketing_opt_in_at: string | null
          marketing_opt_in_source: string | null
          marketing_opt_out_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id: string
          marketing_consent_version?: string | null
          marketing_opt_in?: boolean
          marketing_opt_in_at?: string | null
          marketing_opt_in_source?: string | null
          marketing_opt_out_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          marketing_consent_version?: string | null
          marketing_opt_in?: boolean
          marketing_opt_in_at?: string | null
          marketing_opt_in_source?: string | null
          marketing_opt_out_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      shared_template_grants: {
        Row: {
          can_edit: boolean
          created_at: string
          grantee_user_id: string
          template_id: string
        }
        Insert: {
          can_edit?: boolean
          created_at?: string
          grantee_user_id: string
          template_id: string
        }
        Update: {
          can_edit?: boolean
          created_at?: string
          grantee_user_id?: string
          template_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shared_template_grants_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "shared_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      shared_templates: {
        Row: {
          created_at: string
          description: string | null
          files_blob_url: string | null
          id: string
          manifest: Json
          name: string
          owner_id: string
          updated_at: string
          visibility: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          files_blob_url?: string | null
          id?: string
          manifest: Json
          name: string
          owner_id: string
          updated_at?: string
          visibility?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          files_blob_url?: string | null
          id?: string
          manifest?: Json
          name?: string
          owner_id?: string
          updated_at?: string
          visibility?: string
        }
        Relationships: []
      }
      stripe_events: {
        Row: {
          attempts: number
          id: string
          last_error: string | null
          lease_expires_at: string | null
          received_at: string
          status: string
          type: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          id: string
          last_error?: string | null
          lease_expires_at?: string | null
          received_at?: string
          status?: string
          type: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          id?: string
          last_error?: string | null
          lease_expires_at?: string | null
          received_at?: string
          status?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          created_at: string
          current_period_end: string | null
          id: string
          plan_id: string
          status: string
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan_id: string
          status: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          cancel_at_period_end?: boolean
          created_at?: string
          current_period_end?: string | null
          id?: string
          plan_id?: string
          status?: string
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
        ]
      }
      user_settings: {
        Row: {
          key: string
          updated_at: string
          user_id: string
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          user_id: string
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          user_id?: string
          value?: Json
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_stripe_event: {
        Args: {
          p_event_id: string
          p_event_type: string
          p_lease_seconds?: number
        }
        Returns: {
          attempts: number
          claimed: boolean
          status: string
        }[]
      }
      consume_feedback_quota: {
        Args: {
          p_content_hash?: string
          p_install_hash?: string
          p_ip_hash: string
        }
        Returns: {
          decision: string
          retry_after: number
        }[]
      }
      get_entitlements: {
        Args: never
        Returns: {
          feature_key: string
          plan_id: string
          value: string
        }[]
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
