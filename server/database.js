'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const { DATABASE_URL, pgSsl } = require('./config');

const sequelize = new Sequelize(DATABASE_URL, {
  dialect: 'postgres',
  logging: false,
  pool: {
    max: 5,
    min: 0,
    acquire: 20_000,
    idle: 10_000
  },
  retry: { max: 0 },
  dialectOptions: {
    statement_timeout: 15_000,
    idle_in_transaction_session_timeout: 15_000,
    ...(pgSsl ? { ssl: pgSsl } : {})
  }
});

const common = {
  timestamps: true,
  underscored: true
};

const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    nickname: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false
    },
    tokenVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    avatar: DataTypes.STRING,
    status: {
      type: DataTypes.STRING(150),
      defaultValue: 'Привет! Я использую ChatApp'
    },
    bio: {
      type: DataTypes.TEXT,
      defaultValue: ''
    },
    friends: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: []
    },
    friendRequests: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: []
    },
    blockedUsers: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: []
    }
  },
  { ...common, tableName: 'users' }
);

const Message = sequelize.define(
  'Message',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    chatKey: DataTypes.STRING,
    groupId: DataTypes.UUID,
    from: {
      type: DataTypes.STRING,
      allowNull: false
    },
    to: DataTypes.STRING,
    text: {
      type: DataTypes.TEXT,
      defaultValue: '',
      allowNull: false
    },
    image: DataTypes.TEXT,
    attachmentName: DataTypes.STRING(180),
    attachmentMime: DataTypes.STRING(80),
    attachmentSize: DataTypes.BIGINT,
    type: {
      type: DataTypes.ENUM('text', 'image'),
      defaultValue: 'text',
      allowNull: false
    },
    read: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    },
    deleted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false
    },
    clientId: DataTypes.STRING(64)
  },
  { ...common, tableName: 'messages' }
);

const Group = sequelize.define(
  'Group',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    name: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    avatar: DataTypes.STRING,
    ownerId: {
      type: DataTypes.STRING,
      allowNull: false
    }
  },
  { ...common, tableName: 'groups' }
);

const GroupMember = sequelize.define(
  'GroupMember',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4
    },
    groupId: {
      type: DataTypes.UUID,
      allowNull: false
    },
    userId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    role: {
      type: DataTypes.ENUM('owner', 'member'),
      defaultValue: 'member',
      allowNull: false
    }
  },
  { ...common, tableName: 'group_members' }
);

const GroupReadState = sequelize.define(
  'GroupReadState',
  {
    groupId: {
      type: DataTypes.UUID,
      primaryKey: true
    },
    userId: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    lastReadAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    }
  },
  {
    timestamps: false,
    underscored: true,
    tableName: 'group_read_states'
  }
);

const Upload = sequelize.define(
  'Upload',
  {
    path: {
      type: DataTypes.STRING,
      primaryKey: true
    },
    ownerId: {
      type: DataTypes.STRING,
      allowNull: false
    },
    state: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'pending'
    },
    bytes: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0
    },
    originalName: DataTypes.STRING(180),
    mime: DataTypes.STRING(80)
  },
  {
    ...common,
    updatedAt: false,
    tableName: 'uploads'
  }
);

module.exports = {
  sequelize,
  User,
  Message,
  Group,
  GroupMember,
  GroupReadState,
  Upload
};
