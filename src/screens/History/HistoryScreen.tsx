import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Alert,
  TextInput,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import { COLORS } from '../../constants';
import { useAppStore } from '../../stores';
import type { ChatSession, ConversationEntry } from '../../types';

export const HistoryScreen: React.FC = () => {
  const {
    chatSessions,
    clearHistory,
    renameSession,
    deleteSession,
    deleteEntry,
  } = useAppStore();

  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const handleClearAll = () => {
    Alert.alert(
      'Borrar todo',
      '¿Borrar todo el historial de conversaciones?',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar', style: 'destructive', onPress: clearHistory },
      ],
    );
  };

  const handleDeleteSession = (session: ChatSession) => {
    Alert.alert(
      'Borrar sesión',
      `¿Borrar "${session.name}" y sus ${session.entries.length} mensajes?`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: () => {
            if (expandedSessionId === session.id) setExpandedSessionId(null);
            deleteSession(session.id);
          },
        },
      ],
    );
  };

  const handleDeleteEntry = (entryId: string) => {
    Alert.alert('Borrar mensaje', '¿Borrar este mensaje?', [
      { text: 'Cancelar', style: 'cancel' },
      { text: 'Borrar', style: 'destructive', onPress: () => deleteEntry(entryId) },
    ]);
  };

  const startEditing = (session: ChatSession) => {
    setEditingSessionId(session.id);
    setEditName(session.name);
  };

  const finishEditing = () => {
    if (editingSessionId && editName.trim()) {
      renameSession(editingSessionId, editName.trim());
    }
    setEditingSessionId(null);
    setEditName('');
  };

  const renderEntry = (item: ConversationEntry) => (
    <View key={item.id} style={styles.entry}>
      <View style={styles.entryRow}>
        <Icon name="microphone" size={14} color={COLORS.primary} />
        <Text style={styles.userMessage} numberOfLines={3}>{item.userMessage.content}</Text>
        <TouchableOpacity onPress={() => handleDeleteEntry(item.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Icon name="close-circle-outline" size={18} color={COLORS.textSecondary} />
        </TouchableOpacity>
      </View>
      <View style={styles.entryRow}>
        <Icon name="robot" size={14} color={COLORS.accent} />
        <Text style={styles.assistantMessage} numberOfLines={4}>{item.assistantMessage.content}</Text>
      </View>
    </View>
  );

  const renderSession = ({ item }: { item: ChatSession }) => {
    const isExpanded = expandedSessionId === item.id;
    const isEditing = editingSessionId === item.id;
    const dateStr = new Date(item.createdAt).toLocaleDateString('es-ES', {
      day: '2-digit', month: 'short', year: 'numeric',
    });

    return (
      <View style={styles.sessionCard}>
        <TouchableOpacity
          style={styles.sessionHeader}
          onPress={() => setExpandedSessionId(isExpanded ? null : item.id)}
          activeOpacity={0.7}
        >
          <View style={styles.sessionInfo}>
            {isEditing ? (
              <TextInput
                style={styles.editInput}
                value={editName}
                onChangeText={setEditName}
                onBlur={finishEditing}
                onSubmitEditing={finishEditing}
                autoFocus
                selectTextOnFocus
              />
            ) : (
              <Text style={styles.sessionName} numberOfLines={1}>{item.name}</Text>
            )}
            <Text style={styles.sessionMeta}>
              {dateStr} · {item.entries.length} mensaje{item.entries.length !== 1 ? 's' : ''}
            </Text>
          </View>

          <View style={styles.sessionActions}>
            <TouchableOpacity onPress={() => startEditing(item)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
              <Icon name="pencil-outline" size={18} color={COLORS.textSecondary} />
            </TouchableOpacity>
            <TouchableOpacity onPress={() => handleDeleteSession(item)} hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}>
              <Icon name="trash-can-outline" size={18} color={COLORS.error} />
            </TouchableOpacity>
            <Icon
              name={isExpanded ? 'chevron-up' : 'chevron-down'}
              size={20}
              color={COLORS.textSecondary}
            />
          </View>
        </TouchableOpacity>

        {isExpanded && (
          <View style={styles.entriesList}>
            {item.entries.length === 0 ? (
              <Text style={styles.noEntries}>Sesión vacía</Text>
            ) : (
              item.entries.map(renderEntry)
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Historial</Text>
        {chatSessions.length > 0 && (
          <TouchableOpacity onPress={handleClearAll}>
            <Icon name="delete-outline" size={24} color={COLORS.error} />
          </TouchableOpacity>
        )}
      </View>

      {chatSessions.length === 0 ? (
        <View style={styles.emptyState}>
          <Icon name="chat-outline" size={64} color={COLORS.textSecondary} />
          <Text style={styles.emptyTitle}>Sin conversaciones</Text>
          <Text style={styles.emptySubtitle}>
            Las conversaciones aparecerán aquí
          </Text>
        </View>
      ) : (
        <FlatList
          data={chatSessions}
          keyExtractor={(item) => item.id}
          renderItem={renderSession}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  title: { fontSize: 24, fontWeight: '700', color: COLORS.text },
  list: { padding: 16, gap: 12 },
  sessionCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    overflow: 'hidden',
  },
  sessionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  sessionInfo: { flex: 1, gap: 2 },
  sessionName: { fontSize: 16, fontWeight: '600', color: COLORS.text },
  sessionMeta: { fontSize: 12, color: COLORS.textSecondary },
  sessionActions: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  editInput: {
    fontSize: 16,
    fontWeight: '600',
    color: COLORS.text,
    backgroundColor: COLORS.background,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  entriesList: {
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 8,
  },
  entry: {
    paddingVertical: 8,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.border,
  },
  entryRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  userMessage: { flex: 1, fontSize: 14, color: COLORS.text, lineHeight: 20 },
  assistantMessage: { flex: 1, fontSize: 14, color: COLORS.textSecondary, lineHeight: 20 },
  noEntries: { fontSize: 13, color: COLORS.textSecondary, paddingVertical: 8 },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  emptyTitle: { fontSize: 20, fontWeight: '700', color: COLORS.text },
  emptySubtitle: { fontSize: 14, color: COLORS.textSecondary },
});
