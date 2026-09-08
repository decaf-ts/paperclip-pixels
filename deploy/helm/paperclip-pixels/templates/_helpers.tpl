{{- define "paperclip-pixels.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "paperclip-pixels.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "paperclip-pixels.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "paperclip-pixels.namespace" -}}
{{- default (.Values.global.namespace | default .Release.Namespace) .Values.namespaceOverride -}}
{{- end -}}

{{- define "paperclip-pixels.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "paperclip-pixels.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "paperclip-pixels.selectorLabels" -}}
app.kubernetes.io/name: {{ include "paperclip-pixels.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "paperclip-pixels.image" -}}
{{- $image := .image -}}
{{- $registry := .registry -}}
{{- $repo := printf "%s/%s" $registry $image.repository -}}
{{- if $image.digest -}}
{{- printf "%s:%s@%s" $repo $image.tag $image.digest -}}
{{- else -}}
{{- printf "%s:%s" $repo $image.tag -}}
{{- end -}}
{{- end -}}

{{- define "paperclip-pixels.imagePullPolicy" -}}
{{- if .Values.image.pullPolicy -}}
{{- .Values.image.pullPolicy -}}
{{- else if (.Values.image.paperclipHost.digest | or .Values.image.pixelAgents.digest) -}}
{{- "IfNotPresent" -}}
{{- else -}}
{{- "Always" -}}
{{- end -}}
{{- end -}}

{{- define "paperclip-pixels.mergeComma" -}}
{{- $pairs := list -}}
{{- range $k, $v := . -}}
{{- if $v -}}
{{- $pairs = append $pairs (printf "%s=%s" $k $v) -}}
{{- end -}}
{{- end -}}
{{- join "," $pairs -}}
{{- end -}}

{{- define "paperclip-pixels.secretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- include "paperclip-pixels.fullname" . }}-secrets
{{- end -}}
{{- end -}}

{{- define "paperclip-pixels.feedPort" -}}
{{- default 8081 .Values.transport.feed.port -}}
{{- end -}}

{{- define "paperclip-pixels.sharedAssetsClaim" -}}
{{- if .Values.sharedAssets.existingClaim -}}
{{- .Values.sharedAssets.existingClaim -}}
{{- else -}}
{{- include "paperclip-pixels.fullname" . }}-shared-assets
{{- end -}}
{{- end -}}
